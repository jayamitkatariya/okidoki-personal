import type { ReactElement, ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * A Kobra tooltip on one control. It portals out of the sidebar (so nothing clips it) and, when it
 * reaches over the browser page, steps the native page aside like any other overlay.
 */
export function Tip({ label, side = "bottom", children }: { label: ReactNode; side?: "top" | "bottom" | "left" | "right"; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  );
}
