/**
 * A built-in Cursor exec (Read / Shell / Write) that is bridged to a declared
 * client tool must be answered with a typed SUCCESS carrying the client's
 * output — not with a rejection.
 *
 * Rejecting it reads to the model as "my own tool did not run", so it retries
 * the same step on the next turn. That is the reported symptom: an agent
 * reading a missing file over and over and never getting to the write.
 *
 * Field numbers come from the agent.v1 schema embedded in the Cursor Agent CLI:
 *   ReadResult{success:1}  -> ReadSuccess{path:1, content:2, total_lines:3}
 *   ShellResult{success:1} -> ShellSuccess{command:1, working_directory:2,
 *                                          exit_code:3, stdout:5}
 *   WriteResult{success:1} -> WriteSuccess{path:1, lines_created:2}
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  encodeExecReadSuccess,
  encodeExecShellSuccess,
  encodeExecWriteSuccess,
} from "../../open-sse/utils/cursorAgentProtobuf.ts";
import { decodeFields } from "../../open-sse/utils/cursorAgentProtobuf/wire.ts";

/** Unwrap connect frame -> AgentClientMessage.exec_client_message (2). */
function execClientMessage(frame: Buffer) {
  const body = frame.subarray(5);
  assert.equal(frame.readUInt32BE(1), body.length, "connect envelope length");
  const acm = decodeFields(body).find((f) => f.fieldNumber === 2);
  assert.ok(acm, "AgentClientMessage.exec_client_message");
  return decodeFields(acm.bytes);
}

function successPayload(frame: Buffer, resultField: number) {
  const ecm = execClientMessage(frame);
  const result = ecm.find((f) => f.fieldNumber === resultField);
  assert.ok(result, `ExecClientMessage field ${resultField}`);
  const success = decodeFields(result.bytes).find((f) => f.fieldNumber === 1);
  assert.ok(success, "result.success (field 1) — NOT rejected (field 2)");
  return { ecm, fields: decodeFields(success.bytes) };
}

test("read success returns the client's file contents on ReadResult.success", () => {
  const frame = encodeExecReadSuccess(4, "exec-r", "/tmp/12/snake.cpp", "line1\nline2");
  const { ecm, fields } = successPayload(frame, 7); // ECM_READ_RESULT

  assert.equal(ecm.find((f) => f.fieldNumber === 1)?.varint, 4n, "ExecClientMessage.id");
  assert.equal(ecm.find((f) => f.fieldNumber === 15)?.bytes.toString("utf8"), "exec-r");
  assert.equal(
    fields.find((f) => f.fieldNumber === 1)?.bytes.toString("utf8"),
    "/tmp/12/snake.cpp"
  );
  assert.equal(fields.find((f) => f.fieldNumber === 2)?.bytes.toString("utf8"), "line1\nline2");
  assert.equal(fields.find((f) => f.fieldNumber === 3)?.varint, 2n, "total_lines");
});

test("shell success carries command, working dir, exit code and stdout", () => {
  const frame = encodeExecShellSuccess(5, "exec-s", "ls -la", "/tmp/12", "total 0", 0);
  const { fields } = successPayload(frame, 2); // ECM_SHELL_RESULT

  assert.equal(fields.find((f) => f.fieldNumber === 1)?.bytes.toString("utf8"), "ls -la");
  assert.equal(fields.find((f) => f.fieldNumber === 2)?.bytes.toString("utf8"), "/tmp/12");
  assert.equal(fields.find((f) => f.fieldNumber === 3)?.varint, 0n, "exit_code");
  assert.equal(fields.find((f) => f.fieldNumber === 5)?.bytes.toString("utf8"), "total 0");
});

test("write success reports the path and the number of lines written", () => {
  const frame = encodeExecWriteSuccess(6, "exec-w", "/tmp/12/snake.cpp", 42);
  const { fields } = successPayload(frame, 3); // ECM_WRITE_RESULT

  assert.equal(
    fields.find((f) => f.fieldNumber === 1)?.bytes.toString("utf8"),
    "/tmp/12/snake.cpp"
  );
  assert.equal(fields.find((f) => f.fieldNumber === 2)?.varint, 42n, "lines_created");
});

test("an empty read result still encodes a success, never a rejection", () => {
  // "File not found" is a legitimate answer from the client: the model must see
  // the exec as completed, otherwise it retries the read forever.
  const frame = encodeExecReadSuccess(7, "exec-r2", "/missing", "");
  const { fields } = successPayload(frame, 7);
  assert.equal(fields.find((f) => f.fieldNumber === 2)?.bytes.toString("utf8"), "");
  assert.equal(fields.find((f) => f.fieldNumber === 3)?.varint, 0n, "total_lines of empty output");
});
