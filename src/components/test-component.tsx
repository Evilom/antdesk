import { AccentColor } from "../types";

export function TestComponent({ accent }: { accent: AccentColor }) {
  return <div style={{ color: accent }}>Theme Test</div>;
}
