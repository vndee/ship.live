import type { ActivityEvent } from "../../shared/types";

const DAY = 24 * 60 * 60 * 1000;
const PEOPLE = [
  "alexchen",
  "sarahpark",
  "minhnguyen",
  "emmarivera",
  "jordanlee",
  "leowang",
];
const REPOS = [
  "platform",
  "web-app",
  "api-gateway",
  "design-system",
  "infrastructure",
];

type Template = Pick<ActivityEvent, "type" | "title" | "repo"> & {
  login: string;
  number?: number;
};

const RECENT: Template[] = [
  {
    type: "merge",
    login: "alexchen",
    repo: "platform",
    title: "Add instant preview environments for every pull request",
    number: 428,
  },
  {
    type: "review",
    login: "sarahpark",
    repo: "web-app",
    title: "A faster, friendlier onboarding experience",
    number: 312,
  },
  {
    type: "release",
    login: "minhnguyen",
    repo: "api-gateway",
    title: "v2.8.0 — faster responses, fewer retries",
  },
  {
    type: "merge",
    login: "emmarivera",
    repo: "design-system",
    title: "Make every interactive component keyboard accessible",
    number: 186,
  },
  {
    type: "pr",
    login: "jordanlee",
    repo: "infrastructure",
    title: "Cut CI cold starts with shared dependency caching",
    number: 94,
  },
  {
    type: "review",
    login: "leowang",
    repo: "platform",
    title: "Add instant preview environments for every pull request",
    number: 428,
  },
  {
    type: "merge",
    login: "sarahpark",
    repo: "web-app",
    title: "Keep search results in sync with the URL",
    number: 309,
  },
  {
    type: "issue",
    login: "minhnguyen",
    repo: "api-gateway",
    title: "Make rate limit headers easier to understand",
    number: 247,
  },
  {
    type: "review",
    login: "emmarivera",
    repo: "design-system",
    title: "Introduce a shared empty state component",
    number: 189,
  },
  {
    type: "push",
    login: "jordanlee",
    repo: "infrastructure",
    title: "Tune build cache configuration and document setup",
  },
  {
    type: "merge",
    login: "leowang",
    repo: "platform",
    title: "Show deploy status directly in the developer portal",
    number: 425,
  },
  {
    type: "review",
    login: "alexchen",
    repo: "api-gateway",
    title: "Add request tracing across service boundaries",
    number: 241,
  },
];

const TITLES: Record<ActivityEvent["type"], string[]> = {
  merge: [
    "Simplify local development with a single setup command",
    "Recover gracefully when a downstream service is unavailable",
    "Add clear validation messages to workspace settings",
    "Speed up the test suite with isolated fixtures",
    "Improve loading states on slow connections",
    "Share request tracing context across services",
    "Remove a race condition from background jobs",
    "Document the deployment rollback workflow",
  ],
  review: [
    "Simplify the permissions model for project members",
    "Add regression coverage for timezone handling",
    "Improve the empty state for newly created projects",
    "Make pagination consistent across API endpoints",
    "Add graceful shutdown to the job worker",
    "Refresh shared form components and error states",
    "Reduce unnecessary requests during navigation",
    "Add health checks for service dependencies",
  ],
  release: [
    "v1.12.0 — a smoother developer experience",
    "v3.4.1 — reliability and performance improvements",
    "v2.7.0 — new components, better accessibility",
  ],
  issue: [
    "Surface actionable errors when a deployment fails",
    "Add examples for the new webhook payload format",
    "Improve focus management after closing a dialog",
  ],
  pr: [
    "Add an organization-wide audit trail",
    "Streamline the first-run project setup",
    "Bring consistent telemetry to background jobs",
  ],
  push: [
    "Polish validation edge cases and update examples",
    "Tidy up integration fixtures and improve docs",
    "Refine shared types and simplify error handling",
  ],
};

/** Fictional sample data only. IDs and content are stable for a supplied clock. */
export function createDemoEvents(now = Date.now()): ActivityEvent[] {
  const today = new Date(now);
  today.setUTCHours(0, 0, 0, 0);
  const elapsedToday = now - today.getTime();
  const recentSpan = Math.min(elapsedToday, 3 * 60 * 60 * 1000);

  // Keep Monday useful in the demo: 24 merges, 32 reviews and 3 releases today.
  const todayTypes: ActivityEvent["type"][] = [
    ...Array<ActivityEvent["type"]>(20).fill("merge"),
    ...Array<ActivityEvent["type"]>(28).fill("review"),
    "release",
    "release",
    "issue",
    "issue",
    "issue",
    "pr",
    "pr",
    "pr",
    "push",
    "push",
    "push",
    "push",
  ];
  // Interleave today's generated activity so filtering and the chronological feed feel natural.
  const mixedTypes = todayTypes.map(
    (_, index) => todayTypes[(index * 17) % todayTypes.length],
  );
  const historyTypes: ActivityEvent["type"][] = [
    "merge",
    "review",
    "review",
    "push",
    "merge",
    "pr",
    "issue",
    "review",
  ];
  const events: ActivityEvent[] = [];

  for (let index = 0; index < 120; index += 1) {
    const recent = RECENT[index];
    const type =
      recent?.type ??
      (index < 72
        ? mixedTypes[index - 12]
        : historyTypes[(index - 72) % historyTypes.length]);
    const repo =
      recent?.repo ?? REPOS[(index * 3 + Math.floor(index / 7)) % REPOS.length];
    const login =
      recent?.login ??
      PEOPLE[(index * 5 + Math.floor(index / 6)) % PEOPLE.length];
    let occurredAt: number;
    if (index < 12) {
      occurredAt = now - (recentSpan * (index + 0.2)) / 12;
    } else if (index < 72) {
      occurredAt =
        now -
        recentSpan -
        (Math.max(0, elapsedToday - recentSpan) * (index - 11)) / 61;
    } else {
      const dayAgo = Math.floor((index - 72) / 8) + 1;
      const withinDay = (index - 72) % 8;
      occurredAt =
        today.getTime() - dayAgo * DAY + (8 + withinDay * 1.6) * 60 * 60 * 1000;
    }
    const item: ActivityEvent = {
      id: `demo-${index + 1}`,
      type,
      actor: { login },
      repo,
      title:
        recent?.title ??
        TITLES[type][Math.floor(index / 3) % TITLES[type].length],
      occurredAt: new Date(occurredAt).toISOString(),
    };
    if (
      type === "merge" ||
      type === "review" ||
      type === "pr" ||
      type === "issue"
    ) {
      item.number = recent?.number ?? 480 - index;
    }
    if (type === "merge" || type === "pr") {
      item.additions = 24 + ((index * 37) % 380);
      item.deletions = 6 + ((index * 13) % 90);
    }
    events.push(item);
  }
  return events.sort(
    (a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt),
  );
}
