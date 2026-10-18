/** A camera, microphone or speaker the operator picked, as remembered between sessions. */
export interface SavedDevice {
  id?: string | null;
  label?: string | null;
}

export type DeviceInfo = Pick<MediaDeviceInfo, "deviceId" | "kind" | "label">;

/**
 * Finds a saved device among the current ones: by id, or else by name, because a device can
 * get a new id when it's plugged into a different port or hub. Undefined means "use the
 * system default".
 */
export function resolveDevice(devices: readonly DeviceInfo[], kind: MediaDeviceKind, saved: SavedDevice): DeviceInfo | undefined {
  const ofKind = devices.filter((d) => d.kind === kind);
  return (saved.id ? ofKind.find((d) => d.deviceId === saved.id) : undefined) ?? (saved.label ? ofKind.find((d) => d.label === saved.label) : undefined);
}

/** An error's name and message: some (an OverconstrainedError) have an empty message. */
export function describeError(err: unknown): string {
  const { name, message } = err as Error;
  return [name, message].filter(Boolean).join(": ") || String(err);
}
