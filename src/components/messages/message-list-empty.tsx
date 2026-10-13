import { Check, Mail } from "lucide-react";

/** A quiet, decorative animation; the existing folder/search text stays authoritative. */
export function MessageListEmpty({ text }: { text: string }) {
 return <div data-message-list-empty className="flex max-w-xs flex-col items-center gap-4 px-6 py-6 text-center">
  <div aria-hidden="true" className="mail-empty-art relative flex h-24 w-24 shrink-0 items-center justify-center">
   <span className="mail-empty-halo absolute inset-0 rounded-full bg-blue-50" />
   <span className="mail-empty-envelope relative flex h-16 w-16 items-center justify-center rounded-2xl bg-blue-100 text-blue-600 shadow-sm shadow-blue-100/60 dark:shadow-none">
    <Mail className="h-9 w-9" strokeWidth={1.5} />
   </span>
   <span className="absolute bottom-1 right-1 flex h-7 w-7 items-center justify-center rounded-full border-4 border-white bg-blue-600 text-white dark:border-neutral-100"><Check className="h-3.5 w-3.5" strokeWidth={2.5} /></span>
  </div>
  <p className="text-sm font-medium leading-6 text-neutral-500">{text}</p>
 </div>;
}
