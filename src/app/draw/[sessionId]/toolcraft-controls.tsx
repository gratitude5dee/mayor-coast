"use client";

import { forwardRef, type ButtonHTMLAttributes } from "react";

/**
 * Compact controls adapted from Toolcraft's MIT-licensed interaction model:
 * direct actions, visible pressed state, and large touch targets. Keeping the
 * small wrapper local means it fits the constrained Messages webview without
 * importing Toolcraft's separate application router or persistence runtime.
 * Attribution: https://github.com/pixel-point/toolcraft
 */
export const ToolcraftButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(
  function ToolcraftButton({ className, type = "button", ...props }, ref) {
    return <button ref={ref} type={type} data-toolcraft-control="true" className={className} {...props} />;
  },
);

