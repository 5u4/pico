import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { useTheme, type Theme } from "../theme";

const OPTIONS: { value: Theme; icon: typeof SunIcon; label: string }[] = [
  { value: "system", icon: MonitorIcon, label: "System" },
  { value: "light", icon: SunIcon, label: "Light" },
  { value: "dark", icon: MoonIcon, label: "Dark" },
];

export function TopBar() {
  const { theme, setTheme } = useTheme();
  return (
    <header className="flex items-center justify-between border-b bg-background px-4 py-2">
      <span className="font-semibold tracking-tight">pico</span>
      <div className="flex items-center gap-1 rounded-lg border p-0.5">
        {OPTIONS.map(({ value, icon: Icon, label }) => (
          <button
            key={value}
            type="button"
            onClick={() => setTheme(value)}
            aria-label={label}
            aria-pressed={theme === value}
            className={
              "inline-flex size-7 items-center justify-center rounded-md transition-colors " +
              (theme === value
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:text-foreground")
            }
          >
            <Icon className="size-4" />
          </button>
        ))}
      </div>
    </header>
  );
}
