"use client";
import { useLanguage } from "@/components/language-provider";
import { useMailDisplayOptions } from "@/components/messages/use-mail-display-options";
import { Switch } from "@/components/ui/switch";

export function MailDisplayOptionsSettings() {
 const { t } = useLanguage();
 const [options, update] = useMailDisplayOptions();
 return <fieldset className="space-y-3"><legend className="mb-3 text-sm font-semibold text-neutral-900">{t("settings.display.customize")}</legend>
  {(["categories", "preview", "unreadMarks", "avatars"] as const).map(key => <label key={key} className="flex min-h-10 items-center justify-between gap-3 text-sm text-neutral-700"><span>{t(`settings.display.${key}`)}</span><Switch aria-label={t(`settings.display.${key}`)} checked={options[key]} onCheckedChange={value => update({ [key]: value })} /></label>)}
  <label className="flex flex-col gap-2 pt-2 text-sm text-neutral-700">{t("settings.display.pageSize")}<select aria-label={t("settings.display.pageSize")} value={options.pageSize} onChange={event => update({ pageSize: Number(event.target.value) })} className="min-h-11 rounded-xl border border-neutral-200 bg-white px-3 text-neutral-900">{[25,50,100].map(size => <option key={size} value={size}>{size}</option>)}</select></label>
 </fieldset>;
}
