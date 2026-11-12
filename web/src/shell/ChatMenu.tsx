import { useState } from "react";
import { useDashboard } from "../store";
import { ConfirmModal, PixelIcon, type ConfirmRequest } from "../components/ui";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { Thread } from "../types";

/**
 * A chat's actions: archive (or bring back) and delete. Used on sidebar rows and in a chat's header.
 * `className` styles the trigger only (the sidebar hides it until hover).
 */
export function ChatMenu({ thread, className, onGone }: { thread: Thread; className?: string; onGone?: () => void }) {
  const { invoke, notify } = useDashboard();
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const title = thread.title || "New chat";
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<button type="button" className={className} aria-label={`More for “${title}”`} onClick={(event) => event.stopPropagation()} />}
        >
          <PixelIcon name="dots" size={14} />
        </DropdownMenuTrigger>
        <DropdownMenuContent width="menu" align="end">
          <DropdownMenuItem
            onClick={() => {
              invoke("archiveThread", { id: thread.id });
              notify(thread.archived ? "Back in your chats" : "Archived", title, "info");
              if (!thread.archived) onGone?.();
            }}
          >
            <PixelIcon name="folder" size={15} />
            {thread.archived ? "Unarchive" : "Archive"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onClick={() =>
              setConfirm({
                title: "Delete this chat?",
                detail: `“${title}” and its messages will be gone. Its tasks stay in History.`,
                action: "Delete chat",
                onConfirm: () => {
                  invoke("deleteThread", { id: thread.id });
                  notify("Chat deleted", title, "info");
                  onGone?.();
                },
              })
            }
          >
            <PixelIcon name="trash" size={15} />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmModal request={confirm} onClose={() => setConfirm(null)} />
    </>
  );
}
