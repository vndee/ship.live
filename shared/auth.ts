export type LoginProvider = "google" | "github";

export interface AuthUser {
  id: string;
  name: string;
  avatarUrl?: string;
}

export interface SessionResponse {
  user: AuthUser | null;
  csrfToken?: string;
  providers: Record<LoginProvider, boolean>;
  configured: boolean;
}
