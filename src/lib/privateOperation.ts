export type PrivateOperationTarget =
  | { kind: "disconnect" }
  | { kind: "delete-note"; workspaceId: string; noteId: string };

export type PrivateOperation = PrivateOperationTarget & {
  id: number;
  userId: string;
  status: "pending" | "failed";
  error?: string;
};
export interface PrivateOperationState {
  sequence: number;
  operation: PrivateOperation | null;
}
export type PrivateOperationAction =
  | { type: "start"; operation: PrivateOperation }
  | { type: "failed"; id: number; error: string }
  | { type: "complete"; id: number }
  | { type: "reset"; sequence: number };

export const emptyPrivateOperation: PrivateOperationState = {
  sequence: 0,
  operation: null,
};

/** This state lives above the keyed private view, so clearing content cannot lose a mutation result. */
export function privateOperationReducer(
  state: PrivateOperationState,
  action: PrivateOperationAction,
): PrivateOperationState {
  if (action.type === "reset")
    return action.sequence > state.sequence
      ? { sequence: action.sequence, operation: null }
      : state;
  if (action.type === "start")
    return action.operation.id > state.sequence
      ? { sequence: action.operation.id, operation: action.operation }
      : state;
  if (!state.operation || action.id !== state.sequence) return state;
  if (action.type === "complete") return { ...state, operation: null };
  return {
    ...state,
    operation: { ...state.operation, status: "failed", error: action.error },
  };
}
