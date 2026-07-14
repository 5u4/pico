import "./styles.css";
import { Sidebar } from "./components/sidebar";
import { Thread } from "./components/thread";
import { RuntimeProvider } from "./runtime";

export function App() {
  return (
    <RuntimeProvider>
      <div className="flex h-dvh">
        <Sidebar />
        <div className="flex-1">
          <Thread />
        </div>
      </div>
    </RuntimeProvider>
  );
}
