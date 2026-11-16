"use client";
import { useContext, type ComponentProps } from "react";
import { OTPInput, OTPInputContext } from "input-otp";
import { cn } from "cn";
export function InputOTP({ containerClassName, ...props }: ComponentProps<typeof OTPInput>) {
  return <OTPInput containerClassName={cn("otp", containerClassName)} {...props} />;
}
export function InputOTPSlot({ index }: { index: number }) {
  const { slots } = useContext(OTPInputContext);
  const slot = slots[index];
  return (
    <div aria-hidden="true" className={cn("input otp-slot", slot?.isActive && "input--focus")}>
      {slot?.char}
      {slot?.hasFakeCaret && <span className="otp-caret" />}
    </div>
  );
}
