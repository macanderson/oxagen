"use client"

/**
 * Oxagen brand assets with automatic light/dark adaptation.
 * Uses currentColor so they inherit the foreground color naturally.
 */

export function OxagenLogomark({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 256 256"
      fill="none"
      role="img"
      aria-label="Oxagen logomark"
      className={className}
    >
      <g>
        <circle
          cx="138.37"
          cy="128"
          r="50.69"
          fill="none"
          stroke="currentColor"
          strokeWidth="11.52"
        />
        <line
          x1="174.22"
          y1="92.15"
          x2="212.1"
          y2="54.26"
          stroke="currentColor"
          strokeWidth="10.37"
          strokeLinecap="round"
        />
        <line
          x1="174.22"
          y1="163.85"
          x2="212.1"
          y2="201.74"
          stroke="currentColor"
          strokeWidth="10.37"
          strokeLinecap="round"
        />
        <line
          x1="87.67"
          y1="128"
          x2="46.2"
          y2="128"
          stroke="currentColor"
          strokeWidth="10.37"
          strokeLinecap="round"
        />
        <circle cx="138.37" cy="128" r="16.13" fill="currentColor" />
        <circle cx="221.33" cy="45.04" r="12.67" fill="currentColor" />
        <circle cx="221.33" cy="210.96" r="12.67" fill="currentColor" />
        <circle cx="34.67" cy="128" r="12.67" fill="currentColor" />
      </g>
    </svg>
  )
}

export function OxagenWordmark({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 498.4 174.4"
      fill="none"
      role="img"
      aria-label="Oxagen"
      className={className}
    >
      {/* O */}
      <path
        d="M1141 523C1141 904 905 1079 620 1079C335 1079 99 904 99 523C99 143 335 -24 620 -24C905 -24 1141 143 1141 523ZM883 524C883 267 773 176 620 176C467 176 357 267 357 524C357 781 467 879 620 879C773 879 883 781 883 524Z"
        transform="translate(26 110) scale(0.06 -0.06)"
        fill="currentColor"
      />
      {/* x */}
      <path
        d="M74 1055 472 537 58 0H348L605 363L884 0H1182L769 536L1166 1055H885L636 707L368 1055Z"
        transform="translate(100.4 110) scale(0.06 -0.06)"
        fill="currentColor"
      />
      {/* a */}
      <path
        d="M586 1079C270 1079 149 951 149 770V718H377L378 759C379 864 457 904 571 904C684 904 762 867 762 735V592C459 595 114 555 114 259C114 83 235 -24 420 -24C569 -24 678 45 753 127H778C788 41 832 -22 972 -22C1019 -22 1070 -15 1126 0V184C1039 175 1017 193 1017 260V747C1017 991 852 1079 586 1079ZM379 293C379 406 492 458 690 458C715 458 739 457 762 454V235C698 190 627 160 546 160C442 160 379 209 379 293Z"
        transform="translate(174.8 110) scale(0.06 -0.06)"
        fill="currentColor"
      />
      {/* g */}
      <path
        d="M99 584C99 294 242 95 494 95C644 95 748 166 815 251H828V33C828 -159 733 -221 596 -221C469 -221 399 -166 362 -66L131 -115C169 -276 287 -397 596 -397C920 -397 1083 -264 1083 61V1055H861L848 922H814C757 1007 653 1077 502 1077C247 1077 99 877 99 584ZM357 584C357 765 451 866 614 866C686 866 758 846 828 796V377C759 327 687 307 613 307C448 307 357 406 357 584Z"
        transform="translate(249.2 110) scale(0.06 -0.06)"
        fill="currentColor"
      />
      {/* e */}
      <path
        d="M99 529C99 164 317 -24 631 -24C844 -24 1040 64 1115 283L868 319C824 220 739 176 631 176C461 176 366 287 358 498H1118V598C1118 920 943 1079 641 1079C320 1079 99 895 99 529ZM368 653C400 811 498 880 633 880C773 880 870 808 870 653Z"
        transform="translate(323.6 110) scale(0.06 -0.06)"
        fill="currentColor"
      />
      {/* n */}
      <path
        d="M1083 0V769C1083 987 980 1078 796 1078C630 1078 523 1003 427 899H394L379 1055H157V0H412V752C485 826 571 874 673 874C761 874 828 838 828 702V0Z"
        transform="translate(398 110) scale(0.06 -0.06)"
        fill="currentColor"
      />
    </svg>
  )
}

export function OxagenLockup({ className }: { className?: string }) {
  return (
    <div className={className}>
      <OxagenLogomark className="size-7 shrink-0" />
      <OxagenWordmark className="hidden h-4 w-auto sm:block" />
    </div>
  )
}
