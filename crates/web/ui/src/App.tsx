import { PicoRuntimeProvider } from "./runtime";
import { ThemeProvider } from "./theme";
import { TopBar } from "./components/top-bar";
import { Thread } from "./components/thread";

export default function App() {
  return (
    <ThemeProvider>
      <PicoRuntimeProvider>
        <div className="flex h-dvh flex-col">
          <TopBar />
          <Thread />
        </div>
      </PicoRuntimeProvider>
    </ThemeProvider>
  );
}
