// React Query のキー
export const qk = {
  session: ["session"] as const,
  list: (view: "active" | "archived") => ["instructions", view] as const,
  lists: ["instructions"] as const,
  detail: (id: string) => ["instruction", id] as const,
  events: (id: string) => ["events", id] as const,
  projects: ["projects"] as const,
  usage: ["usage"] as const,
  artifact: (id: string) => ["artifact", id] as const,
};
