import {
  AlarmClock,
  ArrowLeft,
  ArrowRight,
  Ban,
  CalendarClock,
  Check,
  CircleCheck,
  CircleX,
  Clock,
  Eye,
  Inbox,
  Info,
  ListTodo,
  Lock,
  LogOut,
  Mail,
  MessageCircle,
  Moon,
  PenLine,
  Phone,
  PhoneMissed,
  Receipt,
  RefreshCw,
  Shuffle,
  Sun,
  UserPlus,
  WalletCards,
  ChartColumn,
  Hourglass,
  History,
  type LucideIcon,
} from "lucide-react";
const icons = {
  alarm: AlarmClock,
  back: ArrowLeft,
  next: ArrowRight,
  ban: Ban,
  callback: CalendarClock,
  check: Check,
  done: CircleCheck,
  error: CircleX,
  clock: Clock,
  eye: Eye,
  inbox: Inbox,
  info: Info,
  queue: ListTodo,
  lock: Lock,
  logout: LogOut,
  mail: Mail,
  whatsapp: MessageCircle,
  moon: Moon,
  edit: PenLine,
  call: Phone,
  missed: PhoneMissed,
  payments: Receipt,
  refresh: RefreshCw,
  shuffle: Shuffle,
  sun: Sun,
  assign: UserPlus,
  accounts: WalletCards,
  funnel: ChartColumn,
  wait: Hourglass,
  history: History,
} satisfies Record<string, LucideIcon>;
export type IconName = keyof typeof icons;
export function Icon({
  name,
  size = "normal",
}: {
  name: IconName;
  size?: "small" | "normal" | "large";
}) {
  const Component = icons[name];
  return (
    <Component
      aria-hidden="true"
      className={
        size === "small"
          ? "i-14 w-[14px] h-[14px] flex-none"
          : size === "large"
            ? "i-20 w-[20px] h-[20px] flex-none"
            : "i w-[16px] h-[16px] flex-none"
      }
    />
  );
}
