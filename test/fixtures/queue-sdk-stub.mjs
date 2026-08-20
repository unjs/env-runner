// Stand-in for the `@vercel/queue` package, imported by specifier.
export const registrations = [];

export class QueueClient {}

export function registerDevConsumer(options) {
  registrations.push(options);
  return () => registrations.splice(registrations.indexOf(options), 1);
}
