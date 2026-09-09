import type { ActivityEvent } from "../../shared/types";

export interface PrivateFeedState {
  generation: number;
  revision: number;
  events: ActivityEvent[];
  updatedAt: string;
  loading: boolean;
  hasSnapshot: boolean;
  streaming: boolean;
  error: string;
  notice: string;
}
export type PrivateFeedAction =
  | {
      type: "reset";
      generation: number;
      events?: ActivityEvent[];
      error?: string;
    }
  | {
      type: "snapshot";
      generation: number;
      events: ActivityEvent[];
      updatedAt: string;
      notice?: string;
    }
  | { type: "loading"; generation: number; value: boolean }
  | { type: "streaming"; generation: number; value: boolean }
  | { type: "error"; generation: number; message: string };

export const emptyPrivateFeed: PrivateFeedState = {
  generation: 0,
  revision: 0,
  events: [],
  updatedAt: "",
  loading: false,
  hasSnapshot: false,
  streaming: false,
  error: "",
  notice: "",
};

/** Every identity/access transition invalidates both cached data and in-flight responses. */
export function privateFeedReducer(
  state: PrivateFeedState,
  action: PrivateFeedAction,
): PrivateFeedState {
  if (action.type === "reset" || action.type === "error") {
    if (action.generation < state.generation) return state;
    return {
      ...emptyPrivateFeed,
      generation: action.generation,
      revision: state.revision + 1,
      events: action.type === "reset" ? action.events || [] : [],
      error: action.type === "error" ? action.message : action.error || "",
      updatedAt: new Date().toISOString(),
    };
  }
  if (action.generation !== state.generation) return state;
  switch (action.type) {
    case "snapshot":
      // Replacement is essential: revoked repositories and deleted notes must disappear.
      return {
        ...state,
        events: action.events,
        updatedAt: action.updatedAt,
        notice: action.notice || "",
        loading: false,
        hasSnapshot: true,
        error: "",
      };
    case "loading":
      return { ...state, loading: action.value };
    case "streaming":
      return { ...state, streaming: action.value };
  }
}

export function isAccessFailure(status: number) {
  return status === 401 || status === 403 || status === 503;
}
