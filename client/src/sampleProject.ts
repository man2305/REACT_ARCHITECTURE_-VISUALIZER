import type { SourceFile } from "@rav/shared";

export const sampleProject: SourceFile[] = [
  {
    path: "src/App.tsx",
    content: `
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { ThemeProvider } from "./context/ThemeContext";
import { Navbar } from "./components/Navbar";
import { Home } from "./pages/Home";
import { Dashboard } from "./pages/Dashboard";
import { Footer } from "./components/Footer";

export function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <Navbar title="Architecture Visualizer" />
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/dashboard" element={<Dashboard />} />
        </Routes>
        <Footer />
      </BrowserRouter>
    </ThemeProvider>
  );
}
`
  },
  {
    path: "src/components/Navbar.tsx",
    content: `
import { useMemo } from "react";
import { Logo } from "./Logo";
import { Menu } from "./Menu";

export function Navbar({ title }: { title: string }) {
  const links = useMemo(() => ["Home", "Dashboard"], []);
  return (
    <nav>
      <Logo />
      <Menu items={links} title={title} />
    </nav>
  );
}
`
  },
  {
    path: "src/components/Menu.tsx",
    content: `
export function Menu({ items }: { items: string[] }) {
  return <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul>;
}
`
  },
  {
    path: "src/components/Logo.tsx",
    content: `
export function Logo() {
  return <strong>RAV</strong>;
}
`
  },
  {
    path: "src/components/Footer.tsx",
    content: `
export function Footer() {
  return <footer>Built for static analysis practice.</footer>;
}
`
  },
  {
    path: "src/pages/Home.tsx",
    content: `
import { useEffect, useState } from "react";
import axios from "axios";
import { Hero } from "../components/Hero";

export function Home() {
  const [users, setUsers] = useState([]);

  useEffect(() => {
    axios.get("/api/users").then((response) => setUsers(response.data));
  }, []);

  return <Hero count={users.length} />;
}
`
  },
  {
    path: "src/components/Hero.tsx",
    content: `
export function Hero({ count }: { count: number }) {
  return <section>{count} users loaded</section>;
}
`
  },
  {
    path: "src/pages/Dashboard.tsx",
    content: `
import { Sidebar } from "../components/Sidebar";
import { Profile } from "../components/Profile";

export function Dashboard() {
  return (
    <main>
      <Sidebar />
      <Profile />
    </main>
  );
}
`
  },
  {
    path: "src/components/Sidebar.tsx",
    content: `
export function Sidebar() {
  return <aside>Navigation</aside>;
}
`
  },
  {
    path: "src/components/Profile.tsx",
    content: `
export function Profile() {
  return <section>Profile</section>;
}
`
  },
  {
    path: "src/components/UnusedCard.tsx",
    content: `
export function UnusedCard() {
  return <article>Unused</article>;
}
`
  },
  {
    path: "src/context/ThemeContext.tsx",
    content: `
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return <div data-theme="dark">{children}</div>;
}
`
  }
];
