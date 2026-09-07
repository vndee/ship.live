import assert from "node:assert/strict";
import { test } from "node:test";
import {
  emptyPrivateOperation,
  privateOperationReducer,
  type PrivateOperationTarget,
} from "./privateOperation.ts";

test("disconnect and delete failures retain their target and error after the private view is cleared", () => {
  const targets: PrivateOperationTarget[] = [
    { kind: "disconnect" },
    {
      kind: "delete-note",
      workspaceId: "personal-journal",
      noteId: "note-123",
    },
  ];
  for (const target of targets) {
    const pending = privateOperationReducer(emptyPrivateOperation, {
      type: "start",
      operation: { ...target, id: 1, userId: "builder", status: "pending" },
    });
    assert.equal(pending.operation?.status, "pending");
    const failed = privateOperationReducer(pending, {
      type: "failed",
      id: 1,
      error: "Could not confirm the operation. Retry or reload activity.",
    });
    assert.equal(failed.operation?.status, "failed");
    assert.equal(failed.operation?.kind, target.kind);
    assert.match(failed.operation?.error || "", /Retry or reload/);
    const retry = privateOperationReducer(failed, {
      type: "start",
      operation: { ...target, id: 2, userId: "builder", status: "pending" },
    });
    assert.equal(retry.operation?.error, undefined);
    assert.equal(
      privateOperationReducer(retry, { type: "complete", id: 2 }).operation,
      null,
    );
  }
});

test("logout or account replacement rejects late mutation success, failure, and start actions", () => {
  const pending = privateOperationReducer(emptyPrivateOperation, {
    type: "start",
    operation: {
      kind: "disconnect",
      id: 1,
      userId: "old-builder",
      status: "pending",
    },
  });
  const cleared = privateOperationReducer(pending, {
    type: "reset",
    sequence: 2,
  });
  const next = privateOperationReducer(cleared, {
    type: "start",
    operation: {
      kind: "delete-note",
      workspaceId: "new-journal",
      noteId: "new-note",
      id: 3,
      userId: "new-builder",
      status: "pending",
    },
  });
  assert.equal(
    privateOperationReducer(next, {
      type: "failed",
      id: 1,
      error: "Old account error",
    }),
    next,
  );
  assert.equal(
    privateOperationReducer(next, { type: "complete", id: 1 }),
    next,
  );
  assert.equal(
    privateOperationReducer(next, {
      type: "start",
      operation: pending.operation!,
    }),
    next,
  );
});
