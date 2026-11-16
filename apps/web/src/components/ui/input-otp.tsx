"use client";
import { useContext, type ComponentProps } from "react";
import { OTPInput, OTPInputContext } from "input-otp";
import { cn } from "@/lib/utils";
export function InputOTP({ containerClassName, ...props }: ComponentProps<typeof OTPInput>) {
  return (
    <OTPInput
      containerClassName={cn(
        "otp flex gap-related w-full max-phone:[.sign-sheet_&]:gap-compact",
        containerClassName,
      )}
      {...props}
    />
  );
}
export function InputOTPSlot({ index }: { index: number }) {
  const { slots } = useContext(OTPInputContext);
  const slot = slots[index];
  return (
    <div
      aria-hidden="true"
      className={cn(
        "input flex items-center gap-related border-[1px] border-solid border-control-border rounded-control bg-surface text-foreground text-(length:--text-body) [.sign-sheet_&]:h-[56px] [.sign-sheet_&]:w-full max-phone:min-h-[44px] [&:focus-visible]:[outline:none] [&:focus-visible]:border-primary [&:focus-visible]:[box-shadow:0_0_0_3px_var(--color-selected)] otp-slot flex-1 h-[56px] justify-center p-0 text-(length:--text-code) font-[650]",
        slot?.isActive &&
          "input--focus border-primary [box-shadow:0_0_0_3px_var(--color-selected)]",
      )}
    >
      {slot?.char}
      {slot?.hasFakeCaret && <span className="otp-caret w-[1.5px] h-[26px] bg-primary" />}
    </div>
  );
}
