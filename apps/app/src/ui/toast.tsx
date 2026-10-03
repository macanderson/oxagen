"use client";
// shadcn's toast in the base-maia style (ADR-221), written from
// `ui.shadcn.com/r/styles/base-maia/toast.json` over Base UI's toast. One
// toaster sits in the root layout, and any client code shows a line with
// `toast(text, tone)`, so a toast outlives the component that raised it: a
// dialog that closes, or a tab that remounts after a write re-reads the page.
//
// The stack keeps maia's shape: newest in front, older ones peeking behind,
// the stack opening on hover or focus, a swipe down or right to dismiss. It
// sits where the mockup's toast sat (engine.css `#toast`), centred above the
// page's foot, and on a phone it clears the thumb bar. The surface is the
// translucent popup surface every menu and hover card uses. The tone is an
// icon in the state vocabulary the badges use, never the gold.
//
// Every toast is polite: the viewport is a live region, and Base UI keeps a
// toast on screen while the pointer or focus is inside the stack.
import { Toast } from "@base-ui/react/toast";
import {
  CheckCircleIcon,
  type Icon,
  InfoIcon,
  WarningIcon,
  XCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useTranslations } from "next-intl";
import { Button } from "./button";

type ToastTone = "allowed" | "approval" | "denied" | "failed";

/**
 * engine.js: `setTimeout(function(){t.remove();},4200)`. Every toast leaves
 * after this long unless the pointer or focus is in the stack.
 *
 * @internal Exported for the component tests that wait it out.
 */
export const TOAST_MS = 4200;

const TONES: Record<ToastTone, { icon: Icon; className: string }> = {
  allowed: { icon: CheckCircleIcon, className: "text-success" },
  approval: { icon: InfoIcon, className: "text-info" },
  denied: { icon: WarningIcon, className: "text-warning" },
  failed: { icon: XCircleIcon, className: "text-error" },
};

function isTone(type: string): type is ToastTone {
  return Object.hasOwn(TONES, type);
}

function toneOf(type: string | undefined): ToastTone {
  return type !== undefined && isTone(type) ? type : "allowed";
}

// One manager for the app. `add` reaches whichever <Toaster /> is subscribed.
// Base UI's provider subscribes in an effect, so the root layout renders the
// toaster before the page: React runs sibling effects in order, and a page's
// mount effect that calls `toast()` then finds the toaster listening. With no
// toaster mounted, `add` has no listener and the line is dropped.
const manager = Toast.createToastManager();

/** Shows one line in the app's toast stack. */
export function toast(text: string, tone: ToastTone = "allowed"): void {
  manager.add({ title: text, type: tone });
}

/** The app's one toast stack. The root layout mounts it once. */
export function Toaster() {
  const t = useTranslations("ui.toast");
  return (
    <Toast.Provider toastManager={manager} timeout={TOAST_MS} limit={3}>
      <Toast.Portal>
        <Toast.Viewport
          aria-label={t("region")}
          data-testid="toasts"
          className="pointer-events-none fixed inset-x-4 bottom-17.5 z-60 mx-auto w-auto max-w-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-md:bottom-(--toast-bottom-mobile)"
        >
          <ToastList closeLabel={t("close")} />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}

function ToastList({ closeLabel }: { closeLabel: string }) {
  const { toasts } = Toast.useToastManager();
  return toasts.map((item) => {
    const tone = toneOf(item.type);
    const { icon: ToneIcon, className: toneClass } = TONES[tone];
    return (
      <Toast.Root
        key={item.id}
        toast={item}
        data-toast=""
        data-tone={tone}
        className={
          "group/toast pointer-events-auto absolute right-0 bottom-0 isolate w-full origin-bottom rounded-2xl bg-app-raised-bg/55 dark:bg-app-raised-bg/70 text-app-raised-fg shadow-pop ring-1 ring-foreground/5 will-change-transform select-none dark:ring-foreground/10 " +
          "before:pointer-events-none before:absolute before:inset-0 before:-z-1 before:rounded-[inherit] before:backdrop-blur-lg dark:before:backdrop-blur-2xl before:backdrop-saturate-150 " +
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring " +
          "h-(--height) " +
          "after:absolute after:top-full after:left-0 after:w-full " +
          "data-expanded:h-(--toast-height) " +
          "data-limited:opacity-0"
        }
      >
        <Toast.Content className="flex h-full items-center gap-3 overflow-hidden p-4 transition-opacity duration-(--motion-base) ease-(--ease-hover) data-behind:opacity-0 data-expanded:opacity-100">
          <ToneIcon
            aria-hidden="true"
            weight="fill"
            className={`size-4 shrink-0 ${toneClass}`}
          />
          {/* A paragraph, not Base UI's default <h2>: a toast is a line of
              news, and it names the toast's dialog either way. */}
          <Toast.Title
            render={<p />}
            className="min-w-0 flex-1 text-base font-medium"
          >
            {item.title}
          </Toast.Title>
          <Toast.Close
            aria-label={closeLabel}
            render={<Button variant="ghost" size="icon-sm" />}
            className="relative shrink-0 after:absolute after:-inset-2"
          >
            <XIcon aria-hidden="true" />
          </Toast.Close>
        </Toast.Content>
      </Toast.Root>
    );
  });
}
