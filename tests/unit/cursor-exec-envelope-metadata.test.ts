/**
 * Cursor moved the ExecServerMessage envelope around, which silently broke the
 * MCP tool-call round trip: every Cursor request that actually invokes a tool
 * hung until the stream safety timeout (46s / CURSOR_STREAM_TIMEOUT_MS) and
 * returned HTTP 502 "cursor-agent stream timed out".
 *
 * Two concrete drifts, both captured from a live CURSOR_DUMP_FILE against
 * grok-4.7 (the hex below is verbatim from that dump):
 *
 *   1. `exec_id` is no longer field 15. It lives in a metadata envelope on
 *      field 19 (`{1: conversation, 2: exec_id}`), so every ExecClientMessage
 *      we sent back carried an empty exec_id and the server could not correlate
 *      it with its pending request.
 *
 *   2. `decodeExecEventContext` picked the variant as "the first LEN field that
 *      is not field 15". Field 19 IS a LEN field, so it always won — the real
 *      variant (the MCP request on field 36) was never looked at and
 *      `decodeExecServerEvent` returned null, dropping the event entirely with
 *      no log line.
 *
 * Frames used below:
 *   #1 request_context_args (field 10) + metadata (field 19)
 *   #4 MCP provider request  (field 36) + metadata (field 19), NO field 10
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeExecServerEvent,
  encodeMcpProviderToolsResponse,
} from "../../open-sse/utils/cursorAgentProtobuf.ts";
import { decodeFields } from "../../open-sse/utils/cursorAgentProtobuf/wire.ts";

/** Wrap an ExecServerMessage body as AgentServerMessage.exec_server_message (field 2). */
function asAgentServerMessage(execServerMessageHex: string): Buffer {
  const body = Buffer.from(execServerMessageHex, "hex");
  const header = Buffer.from([0x12]); // field 2, wire type 2
  const length: number[] = [];
  let remaining = body.length;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining > 0) byte |= 0x80;
    length.push(byte);
  } while (remaining > 0);
  return Buffer.concat([header, Buffer.from(length), body]);
}

// Live capture: request_context_args on field 10, metadata on field 19.
const REQUEST_CONTEXT_FRAME = asAgentServerMessage(
  "5226122461376562303666642d343537332d343133632d626233652d62333035373838623435333" +
    "99a01360a2038663336663434656635393661643337333137343034393738653161333839351210" +
    "653339363764333436626462353966351800b80300"
);

// Live capture: MCP provider request on field 36 ({1: "omniroute"}), metadata on field 19.
const MCP_PROVIDER_FRAME = asAgentServerMessage(
  "08019a01360a20386633366634346566353936616433373331373430343937386531613338393512" +
    "10396237306231383332613662383164321800a2020b0a096f6d6e69726f757465b80300"
);

test("exec_id is read from the field-19 metadata envelope, not the absent field 15", () => {
  const event = decodeExecServerEvent(REQUEST_CONTEXT_FRAME);

  assert.ok(event, "request_context frame must decode");
  assert.equal(event.kind, "exec_request_context");
  assert.equal(
    event.execId,
    "e3967d346bdb59f5",
    "exec_id must come from field 19 sub-field 2 — an empty exec_id makes the server drop our reply"
  );
});

test("the metadata envelope on field 19 does not get mistaken for the event variant", () => {
  const event = decodeExecServerEvent(MCP_PROVIDER_FRAME);

  assert.ok(
    event,
    "the MCP provider request must decode — returning null is what left the turn hanging until the safety timeout"
  );
  assert.notEqual(
    event.kind,
    "exec_request_context",
    "field 19 must not be resolved as a request-context variant"
  );
});

test("the MCP provider request on field 36 is decoded with its provider identifier", () => {
  const event = decodeExecServerEvent(MCP_PROVIDER_FRAME);

  assert.ok(event);
  assert.equal(event.kind, "exec_mcp_list_tools");
  assert.equal(event.execMsgId, 1);
  assert.equal(event.execId, "9b70b1832a6b81d2");
  assert.equal(
    (event as { providerIdentifier?: string }).providerIdentifier,
    "omniroute",
    "the identifier must round-trip so the reply can be scoped to our own provider"
  );
});

/**
 * The reply shape was pinned empirically against the live server: bare repeated
 * tools and success-wrapped-on-field-1 were both ignored (turn kept hanging),
 * success{tools:2} produced a real tool call. Encoding it wrong is silent — the
 * server simply never answers — so the bytes are asserted structurally.
 */
test("the MCP provider reply wraps the tools as success{tools} on field 36", () => {
  const frame = encodeMcpProviderToolsResponse(7, "9b70b1832a6b81d2", [
    {
      name: "get_time",
      description: "Get current time",
      inputSchemaBytes: Buffer.from([0x00]),
      providerIdentifier: "omniroute",
      toolName: "get_time",
    },
  ]);

  // Connect envelope: 1 flag byte + 4 length bytes.
  const body = frame.subarray(5);
  assert.equal(frame.readUInt32BE(1), body.length, "connect envelope length must match the body");

  const acm = decodeFields(body);
  const execClientMessage = acm.find((field) => field.fieldNumber === 2);
  assert.ok(execClientMessage, "AgentClientMessage.exec_client_message (2) must be present");

  const ecm = decodeFields(execClientMessage.bytes);
  assert.equal(ecm.find((f) => f.fieldNumber === 1)?.varint, 7n, "ExecClientMessage.id");
  assert.equal(
    ecm.find((f) => f.fieldNumber === 15)?.bytes.toString("utf8"),
    "9b70b1832a6b81d2",
    "ExecClientMessage.exec_id must echo the id taken from the server's metadata envelope"
  );

  const result = ecm.find((f) => f.fieldNumber === 36);
  assert.ok(result, "mcp_provider_result must be on field 36, mirroring the request");

  const success = decodeFields(result.bytes).find((f) => f.fieldNumber === 1);
  assert.ok(success, "result must be success-wrapped on field 1");

  const tools = decodeFields(success.bytes).filter((f) => f.fieldNumber === 2);
  assert.equal(
    tools.length,
    1,
    "tools are repeated on field 2 (same number as RequestContext.tools)"
  );
  assert.match(tools[0].bytes.toString("utf8"), /get_time/);
});

/**
 * Built-in tool execs (shell/read/write/…) still carry their own exec_id on
 * field 15 AND the new metadata envelope on field 19. Their result must echo
 * the field-15 id, so metadata must NOT override it — preferring metadata broke
 * exactly the turns where Cursor routes a client tool onto its built-in shell.
 *
 * Frame below is a live `shell_stream_args` capture (command "dir").
 */
test("a built-in shell exec keeps its own field-15 exec_id despite the metadata envelope", () => {
  const frame = asAgentServerMessage(
    "080372f0010a0364697218b0ea01225563616c6c2d34373763663931382d356366642d346639342d61343062" +
      "2d3664336363653338376434372d320a66635f65373036613531622d646534322d396166352d613766622d36" +
      "37356566306231386631325f302a03646972420c120a0a036469721a0364697250c0b80268027080b899297a" +
      "1f4c6973742063757272656e74206469726563746f727920636f6e74656e7473880101aa0124366663656132" +
      "66622d356438382d343964632d393834652d626136373966376530326430ba012439313661643137642d6631" +
      "36392d343433392d613632662d3231346531373232666439307a2435623665613733662d613364392d346166" +
      "662d613830342d3162393037363462633434329a01360a206437626461323766383937626630626639343130" +
      "6337393532656237303036371210373764313565336666323436373265371800b80301"
  );

  const event = decodeExecServerEvent(frame);
  assert.ok(event, "shell_stream_args must decode");
  assert.equal(event.kind, "exec_shell_stream");
  assert.equal(
    event.execId,
    "5b6ea73f-a3d9-4aff-a804-1b90764bc442",
    "the field-15 exec_id must win over the metadata envelope — the result frame has to echo it"
  );
});
