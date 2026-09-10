import { arrayMove } from "@dnd-kit/sortable";

export function moveService<T extends { id: string }>(
  services: T[],
  activeId: string,
  overId: string,
): T[] {
  const from = services.findIndex((service) => service.id === activeId);
  const to = services.findIndex((service) => service.id === overId);
  if (from < 0 || to < 0 || from === to) return services;
  return arrayMove(services, from, to);
}
