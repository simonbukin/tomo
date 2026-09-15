import { StatusSlot } from "./StatusSlot";

/** The fixed bottom strip: help and settings, usage, the status message, system metrics, and daemon health. */
export function BottomStrip() {
  return (
    <footer className="bottom-strip">
      <StatusSlot />
    </footer>
  );
}
