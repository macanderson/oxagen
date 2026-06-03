"use client";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import {
  Menu,
  MenuPopup,
  MenuItem,
  MenuTrigger,
} from "@/components/ui/menu";

export function ThemeToggle() {
  const { setTheme } = useTheme();
  return (
    <Menu>
      <MenuTrigger render={<Button variant="outline" size="icon" className="relative" aria-label="Toggle theme" />}>
        <Sun className="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
        <Moon className="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
        <span className="sr-only">Toggle theme</span>
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem onClick={() => setTheme("light")}>Light</MenuItem>
        <MenuItem onClick={() => setTheme("dark")}>Dark</MenuItem>
        <MenuItem onClick={() => setTheme("system")}>System</MenuItem>
      </MenuPopup>
    </Menu>
  );
}
