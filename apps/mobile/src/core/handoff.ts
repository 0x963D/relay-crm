export const canOfferCall = (phone: string | null) =>
  phone !== null && phone.replaceAll(/\D/g, "").length >= 7;
export function handoffTarget(channel: "call" | "whatsapp", phone: string): string | null {
  if (/^\s*\+\d[\d\s.-]*[([]\s*0\s*[)\]]/.test(phone)) return null;
  const number = phone.replaceAll(/[\s.()[\]-]/g, "");
  if (channel === "call") return /^\+?\d{7,15}$/.test(number) ? `tel:${number}` : null;
  return /^\+\d{8,15}$/.test(number) ? `https://wa.me/${number.slice(1)}` : null;
}
