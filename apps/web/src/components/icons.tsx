import { cn } from "@/lib/utils";
import {
  AlarmClock,
  ChevronDown,
  ChevronUp,
  X,
  Circle,
  Minus,
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
  down: ChevronDown,
  up: ChevronUp,
  close: X,
  circle: Circle,
  minus: Minus,
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
  className,
}: {
  name: IconName;
  className?: string;
  size?: "small" | "normal" | "large";
}) {
  const Component = icons[name];
  return (
    <Component
      aria-hidden="true"
      className={cn(
        size === "small"
          ? "size-3.5 shrink-0"
          : size === "large"
            ? "size-5 shrink-0"
            : "size-4 shrink-0",
        className,
      )}
    />
  );
}
