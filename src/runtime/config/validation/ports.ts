export const LISTEN_PORT_MIN = 1;
export const PORT_MAX = 65_535;
export const OAUTH_CALLBACK_PORT_MIN = 1_024;

export function isIntegerPort(
  value: unknown,
  minimum = LISTEN_PORT_MIN,
  maximum = PORT_MAX,
): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= minimum
    && value <= maximum;
}
