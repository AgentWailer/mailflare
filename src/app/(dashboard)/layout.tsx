"use client";

import { useEffect, useState } from "react";
import { MailHeader } from "@/components/mail-header";
import { AuthGuard } from "@/components/auth/auth-guard";
import { ComposeProvider } from "@/components/compose/compose-context";
import { MobileComposeButton } from "@/components/compose/mobile-compose-button";
import { FloatingComposer } from "@/components/compose/floating-composer";
import { MailSearchProvider } from "@/components/mail-search/mail-search-context";
import { MailboxProvider } from "@/components/mailbox-provider";
import { DeferredAgentPanel } from "@/components/agent/deferred-agent-panel";
import { useAssistantFullSize } from "@/components/agent/use-assistant-full-size";
import { AssistantOpenContext, AssistantRequestContext } from "@/components/agent/assistant-open-state";
import type { MessageAssistantRequest } from "@/components/agent/assistant-open-state";
import { DashboardNav } from "@/components/dashboard-nav";
import { SidebarProvider } from "@/components/sidebar-state";
import { SidebarAside } from "@/components/sidebar-aside";
import { SidebarResizeBoundary } from "@/components/sidebar-resize-boundary";
import { ShortcutsProvider } from "@/components/shortcuts";
import clsx from "clsx";
import { useDashboardState } from "./dashboard-state";
import { useAssistantAvailability } from "./use-assistant-availability";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { assistantOpen, setAssistantOpen, assistantFullSize, setAssistantFullSize } = useDashboardState();
  const assistantEnabled = useAssistantAvailability();
  const [assistantRequest, setAssistantRequest] = useState<MessageAssistantRequest | null>(null);
  const assistantVisible = assistantEnabled === true && assistantOpen;
  const panelFullSize = useAssistantFullSize(assistantFullSize);

  useEffect(() => {
    if (assistantEnabled === false && (assistantOpen || assistantFullSize)) {
      setAssistantOpen(false);
      setAssistantFullSize(false);
    }
  }, [assistantEnabled, assistantOpen, assistantFullSize, setAssistantOpen, setAssistantFullSize]);

  return (
    <AuthGuard>
      <SidebarProvider mobileOverlay>
        <MailboxProvider>
          <ComposeProvider>
            <MailSearchProvider>
              <ShortcutsProvider>
                <div className="mail-mobile-shell grid h-dvh grid-cols-[minmax(0,1fr)] overflow-hidden bg-[#f6f8fc] transition-[grid-template-columns] md:grid-cols-[var(--sidebar-width)_minmax(0,1fr)]" style={{ transitionDuration: "var(--sidebar-transition-duration)" }}>
                  <SidebarAside>
                    <div className="h-full">
                      <DashboardNav />
                    </div>
                    <SidebarResizeBoundary />
                  </SidebarAside>
                  <div className="flex min-h-0 min-w-0 flex-col">
                    <MailHeader assistantEnabled={assistantEnabled} assistantOpen={assistantOpen} onToggleAssistant={() => { setAssistantOpen(current => !current); setAssistantFullSize(false); }} />
                    <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
                      <AssistantOpenContext.Provider value={assistantVisible}>
                        <AssistantRequestContext.Provider value={assistantEnabled ? (request) => { setAssistantRequest(request); window.dispatchEvent(new CustomEvent("mailflare:assistant-request", { detail: request })); setAssistantOpen(true); setAssistantFullSize(false); } : null}>
                        <main className="mail-mobile-main min-h-0 min-w-0 flex-1 overflow-y-auto rounded-t-3xl bg-white overscroll-contain scrollbar-gutter-stable" aria-hidden={assistantVisible && panelFullSize} inert={assistantVisible && panelFullSize}>
                          {children}
                        </main>
                        </AssistantRequestContext.Provider>
                      </AssistantOpenContext.Provider>
                      <aside className={clsx(panelFullSize ? "pl-0" : "pl-4", `min-h-0 min-w-0 shrink-0 overflow-hidden transition-[width] duration-300 ease-in-out motion-reduce:transition-none pr-2 pb-2 max-md:p-0`, assistantVisible ? "" : "opacity-0")} style={{ width: assistantVisible ? panelFullSize ? "100%" : "min(390px, 100%)" : "0px" }} aria-hidden={!assistantVisible} inert={!assistantVisible}>
                        {assistantEnabled && <DeferredAgentPanel request={assistantRequest} open={assistantVisible} fullSize={panelFullSize} onToggleFullSize={() => setAssistantFullSize((current) => !current)} onClose={() => { setAssistantOpen(false); setAssistantFullSize(false); }} />}
                      </aside>
                    </div>
                  </div>
                  <MobileComposeButton hidden={assistantVisible} />
                  <FloatingComposer />
                </div>
              </ShortcutsProvider>
            </MailSearchProvider>
          </ComposeProvider>
        </MailboxProvider>
      </SidebarProvider>
    </AuthGuard>
  );
}
