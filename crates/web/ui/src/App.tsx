import { PicoRuntimeProvider } from "./runtime";
import { ThemeProvider } from "./theme";
import { TopBar } from "./components/top-bar";
import { Thread } from "./components/thread";
import { Sidebar } from "./components/sidebar";

export default function App() {
  return (
    <ThemeProvider>
      <PicoRuntimeProvider>
        <div className="flex h-dvh">
          <Sidebar />
          <div className="flex min-w-0 flex-1 flex-col">
            <TopBar />
            <Thread />
          </div>
        </div>
      </PicoRuntimeProvider>
    </ThemeProvider>
  );
}
