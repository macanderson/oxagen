import * as React from "react";

/**
 * Card surface and its parts (Header / Title / Description / Body / Footer).
 * `glow` applies the violet focus ring to the featured card; `gradientRing`
 * adds the nebula hairline border; `interactive` enables hover-lift.
 *
 * @startingPoint section="Core" subtitle="Surface with header/body/footer parts" viewport="700x260"
 */
export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  glow?: boolean;
  gradientRing?: boolean;
  interactive?: boolean;
}

export function Card(props: CardProps): React.ReactElement;
export function CardHeader(props: React.HTMLAttributes<HTMLDivElement>): React.ReactElement;
export function CardTitle(props: React.HTMLAttributes<HTMLHeadingElement>): React.ReactElement;
export function CardDescription(props: React.HTMLAttributes<HTMLParagraphElement>): React.ReactElement;
export function CardBody(props: React.HTMLAttributes<HTMLDivElement>): React.ReactElement;
export function CardFooter(props: React.HTMLAttributes<HTMLDivElement>): React.ReactElement;
