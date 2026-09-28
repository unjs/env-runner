export const h = (tag: string, props: Record<string, unknown> | null, ...children: unknown[]) => ({
  tag,
  props,
  children,
});
