import { cn } from "../lib/utils";
import { useConnection } from "../runtime";

export function ConnectionBanner() {
  const status = useConnection();
  if (status !== "reconnecting" && status !== "reconnected") return null;
  const reconnected = status === "reconnected";
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-30 flex justify-center px-3 pt-2">
      <div
        role="status"
        aria-live="polite"
        className={cn(
          "flex items-center gap-2 rounded-full px-3 py-1 text-sm font-medium text-white shadow-sm",
          reconnected ? "bg-emerald-600" : "bg-destructive",
        )}
      >
        <span
          className={cn(
            "size-2 rounded-full bg-white",
            reconnected ? undefined : "animate-pulse",
          )}
        />
        {reconnected ? "Reconnected" : "Disconnected — reconnecting…"}
      </div>
    </div>
  );
}
