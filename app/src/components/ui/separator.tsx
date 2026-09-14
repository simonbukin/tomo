import { Separator as S } from "@base-ui/react/separator";
import type { ComponentProps } from "react";
import { cx, type WithClassName } from "./cx";

export function Separator({ className, orientation = "horizontal", ...rest }: WithClassName<ComponentProps<typeof S>>) {
  return <S orientation={orientation} className={cx("separator", `separator-${orientation}`, className)} {...rest} />;
}
