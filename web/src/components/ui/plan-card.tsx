import { type ReactNode, useEffect, useRef, useState } from 'react'
import { TextMorph } from 'torph/react'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { joinsLetters } from '@/lib/joined-script'
import { cn } from '@/lib/utils'
import { IconCircleDashed, IconDots, IconMinus, IconX, IconCornerDownLeft } from "@tabler/icons-react"

export type PlanStep = {
  label: string
  done?: boolean
}

const REVEAL = 'duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none'

function PlanStepRow({
  step,
  first,
  collapsible,
  expanded,
}: {
  step: PlanStep
  first: boolean
  collapsible: boolean
  expanded: boolean
}) {
  const row = (
    <div className={cn('flex items-center gap-2.5 text-[0.9375rem]', !first && 'pt-2')}>
      <IconCircleDashed aria-hidden className={cn(
                    'size-4 shrink-0',
                    step.done ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground/50',
                  )} />
      <span className={cn('truncate', step.done ? 'text-foreground' : 'text-muted-foreground')}>
        {step.label}
      </span>
    </div>
  )

  if (!collapsible) return <li>{row}</li>

  return (
    <li

      inert={!expanded}
      className={cn('grid transition-[grid-template-rows]', REVEAL)}
      style={{ gridTemplateRows: expanded ? '1fr' : '0fr' }}
    >

      <div className="min-h-0 overflow-hidden">{row}</div>
    </li>
  )
}

const SWAP =
  'col-start-1 row-start-1 transition-[opacity,translate,filter] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none motion-reduce:translate-y-0 motion-reduce:blur-none'

function ViewLabel({ shown, labels }: { shown: string; labels: readonly [string, string] }) {
  return (
    <span className="relative grid">
      {labels.map((label) => (
        <span key={label} aria-hidden className="invisible col-start-1 row-start-1">
          {label}
        </span>
      ))}
      <span dir="auto" className="absolute top-0 left-1/2 -translate-x-1/2 whitespace-nowrap">
        {joinsLetters(shown) ? (
          shown
        ) : (
          <TextMorph
            duration={200}
            ease="cubic-bezier(0.16, 1, 0.3, 1)"
            numbers={false}
            scale={false}
          >
            {shown}
          </TextMorph>
        )}
      </span>
    </span>
  )
}

function MoreToggle({
  hidden,
  expanded,
  onToggle,
}: {
  hidden: number
  expanded: boolean
  onToggle: () => void
}) {
  const swap = SWAP

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-md text-start text-[0.9375rem] text-muted-foreground outline-none',
        'transition-[color,box-shadow,outline-color,outline-offset] duration-(--ring-duration) ease-(--ease-out) motion-reduce:transition-none',
        'hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-1',
      )}
    >

      <span
        aria-hidden
        className="grid size-4 shrink-0 place-items-center text-muted-foreground/50"
      >
        <IconDots className={cn('size-4', swap, expanded ? 'scale-90 opacity-0' : 'scale-100 opacity-100')} />
        <IconMinus className={cn('size-4', swap, expanded ? 'scale-100 opacity-100' : 'scale-90 opacity-0')} />
      </span>

      <span className="grid">
        <span
          className={cn(
            swap,
            expanded
              ? '-translate-y-1 opacity-0 blur-[2px]'
              : 'translate-y-0 opacity-100 blur-none',
          )}

          aria-hidden={expanded}
        >
          {hidden} more
        </span>
        <span
          className={cn(
            swap,
            expanded ? 'translate-y-0 opacity-100 blur-none' : 'translate-y-1 opacity-0 blur-[2px]',
          )}
          aria-hidden={!expanded}
        >
          Show less
        </span>
      </span>
    </button>
  )
}

function Digits({ value }: { value: number }) {
  const chars = String(value).split('')

  return (

    <span
      dir="ltr"
      className="t-digit-group tabular-nums [--digit-blur:1.5px] [--digit-distance:4px] [--digit-dur:260ms] [--digit-ease:var(--ease-out)] [--digit-stagger:40ms]"
    >
      {chars.map((char, index) => (
        <span
          key={`${String(index)}-${char}`}
          className="t-digit is-animating"

          data-stagger={index === 0 ? undefined : index === chars.length - 2 ? '1' : '2'}
        >
          {char}
        </span>
      ))}
    </span>
  )
}

const BANDS = [
  'text-emerald-600 dark:text-emerald-400',
  'text-amber-600 dark:text-amber-400',
  'text-red-600 dark:text-red-400',
] as const

const MARK_SWAP =
  'col-start-1 row-start-1 transition-[opacity,scale,filter] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none'

function CountdownRing({
  left,
  total,
  onCancel,
  cancelLabel,
  cancelHint,
}: {
  left: number
  total: number
  onCancel?: () => void
  cancelLabel: string
  cancelHint: string
}) {
  const RADIUS = 7
  const circumference = 2 * Math.PI * RADIUS
  const remaining = total <= 0 ? 0 : Math.max(0, Math.min(1, left / total))

  const band = BANDS[Math.min(BANDS.length - 1, Math.floor((1 - remaining) * BANDS.length))]

  const ring = (
    <svg
      aria-hidden
      viewBox="0 0 18 18"
      className={cn(

        'size-[18px] -rotate-90 transition-colors duration-500 ease-out motion-reduce:transition-none',
        band,
      )}
    >
      <circle
        cx="9"
        cy="9"
        r={RADIUS}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        opacity={0.25}
      />
      <circle
        cx="9"
        cy="9"
        r={RADIUS}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - remaining)}
        className="transition-[stroke-dashoffset] duration-1000 ease-linear motion-reduce:transition-none"
      />
    </svg>
  )

  if (!onCancel) {
    return <span className="grid shrink-0">{ring}</span>
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={cancelLabel}
            onClick={onCancel}
            className="group/cancel relative grid size-[18px] shrink-0 cursor-pointer place-items-center rounded-full transition-[scale] duration-150 ease-out outline-none after:absolute after:-inset-[11px] after:content-[''] focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.96] motion-reduce:transition-none motion-reduce:active:scale-100"
          >

            <span
              className={cn(
                MARK_SWAP,
                'grid group-hover/cancel:scale-90 group-hover/cancel:opacity-0 group-hover/cancel:blur-[2px] group-focus-visible/cancel:scale-90 group-focus-visible/cancel:opacity-0 group-focus-visible/cancel:blur-[2px]',
              )}
            >
              {ring}
            </span>

            <span
              aria-hidden
              className={cn(
                MARK_SWAP,
                'grid size-[18px] scale-90 place-items-center rounded-full bg-muted text-muted-foreground opacity-0 blur-[2px] group-hover/cancel:scale-100 group-hover/cancel:opacity-100 group-hover/cancel:blur-none group-focus-visible/cancel:scale-100 group-focus-visible/cancel:opacity-100 group-focus-visible/cancel:blur-none',
              )}
            >
              <IconX className="size-2.5" strokeWidth={2.5} />
            </span>
          </button>
        }
      />
      <TooltipContent>{cancelHint}</TooltipContent>
    </Tooltip>
  )
}

export function PlanCard({
  icon,
  title,
  description,
  steps,

  visibleSteps = 3,

  autoApproveIn,
  onApprove,

  onAutoApprove,

  onCancelAutoApprove,

  onView,

  onDownload,
  approveLabel = 'Approve',
  viewLabel = 'View Plan',

  hideLabel = 'Hide Plan',
  extraActions,
  showView = true,
  hotkey = true,
  className,
}: {
  icon?: ReactNode
  title: string
  description?: ReactNode
  steps: Array<PlanStep>
  visibleSteps?: number
  autoApproveIn?: number
  onApprove?: () => void
  onAutoApprove?: () => void
  onCancelAutoApprove?: () => void
  onView?: () => void
  onDownload?: () => void
  approveLabel?: string
  viewLabel?: string
  hideLabel?: string
  /** okidoki: more buttons beside Approve (Not now, Always allow). */
  extraActions?: ReactNode
  /** okidoki: hide the View Plan button when every step already shows. */
  showView?: boolean
  /** okidoki: ⌘↵ approves. Off when several cards can be on screen, so it can't approve the wrong one. */
  hotkey?: boolean
  className?: string
}) {
  const hidden = Math.max(0, steps.length - visibleSteps)
  const [expanded, setExpanded] = useState(false)

  const [left, setLeft] = useState(autoApproveIn ?? 0)

  const [clock, setClock] = useState<'running' | 'leaving' | 'off'>('running')

  const approve = useRef(onApprove)
  approve.current = onApprove
  const expire = useRef(onAutoApprove ?? onApprove)
  expire.current = onAutoApprove ?? onApprove

  useEffect(() => {
    if (!hotkey) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return
      event.preventDefault()
      approve.current?.()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [hotkey])

  useEffect(() => {

    if (autoApproveIn === undefined || clock !== 'running') return
    setLeft(autoApproveIn)

    const id = window.setInterval(() => {
      setLeft((seconds) => {
        if (seconds > 1) return seconds - 1
        window.clearInterval(id)
        expire.current?.()
        return 0
      })
    }, 1000)

    return () => {
      window.clearInterval(id)
    }
  }, [autoApproveIn, clock])

  const view = () => {
    if (hidden === 0) {
      onView?.()
      return
    }
    if (!expanded) onView?.()
    setExpanded((open) => !open)
  }

  const cancelAutoApprove = () => {
    setClock('leaving')
    onCancelAutoApprove?.()
    window.setTimeout(() => setClock('off'), 200)
  }

  return (
    <div
      data-slot="plan-card"
      className={cn(
        'w-full max-w-lg rounded-2xl border bg-card p-5 text-card-foreground',
        className,
      )}
    >
      <div className="flex items-center gap-3">
        {icon ? (

          <span className="t-raise t-label t-raise-warning pointer-events-none relative isolate flex size-7 shrink-0 items-center justify-center rounded-md text-amber-600 before:pointer-events-none before:absolute before:inset-0 before:-z-10 before:rounded-[inherit] before:border before:border-transparent dark:text-amber-400 [&_svg]:size-4">
            {icon}
          </span>
        ) : null}
        <h3 className="text-lg font-semibold tracking-tight">{title}</h3>

        <span className="ms-auto flex items-center gap-1">

          {onDownload ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Download the plan"
                    onClick={onDownload}
                  >
                    <DownloadGlyph />
                  </Button>
                }
              />
              <TooltipContent>Download</TooltipContent>
            </Tooltip>
          ) : null}
        </span>
      </div>

      {description ? (
        <p className="mt-3 text-[0.9375rem] leading-relaxed text-muted-foreground">{description}</p>
      ) : null}

      <div className="mt-4 rounded-xl bg-muted/60 p-3">
        <div className="flex items-center gap-2">
          <ChecklistGlyph />
          <span className="text-[0.9375rem] font-medium">To-dos</span>

          <span className="ms-auto pe-1 text-sm text-muted-foreground tabular-nums">
            {steps.length}
          </span>
        </div>

        <ul className="mt-2.5">
          {steps.map((step, index) => (
            <PlanStepRow
              key={step.label}
              step={step}
              first={index === 0}

              collapsible={index >= visibleSteps}
              expanded={expanded}
            />
          ))}

          {hidden > 0 ? (
            <li className="pt-2">
              <MoreToggle
                hidden={hidden}
                expanded={expanded}
                onToggle={() => setExpanded((open) => !open)}
              />
            </li>
          ) : null}
        </ul>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-3">
        {autoApproveIn === undefined || clock === 'off' ? null : (

          <span
            aria-live="polite"
            className={cn(
              'flex items-center gap-2 text-sm text-muted-foreground transition-[opacity,translate] duration-200 ease-out motion-reduce:transition-none',

              clock === 'leaving' && 'translate-y-1 opacity-0',
            )}
          >
            <CountdownRing
              left={left}
              total={autoApproveIn}
              onCancel={clock === 'running' ? cancelAutoApprove : undefined}

              cancelLabel="Cancel auto approval"
              cancelHint="Cancel"
            />

            <span>
              Auto Approve in <Digits value={left} />s
            </span>
          </span>
        )}

        <span className="ms-auto flex flex-wrap items-center gap-2">
          {extraActions}
          {showView ? (
          <Button
            variant="secondary"
            onClick={view}
            aria-expanded={hidden > 0 ? expanded : undefined}
          >
            {hidden > 0 ? (
              <ViewLabel shown={expanded ? hideLabel : viewLabel} labels={[viewLabel, hideLabel]} />
            ) : (
              viewLabel
            )}
          </Button>
          ) : null}

          <Button onClick={onApprove}>
            {approveLabel}
            {hotkey ? (
            <KbdGroup className="ms-0.5">

              <Kbd
                size="sm"
                className="size-5 justify-center border-transparent bg-background/15 p-0 text-current"
              >
                ⌘
              </Kbd>
              <Kbd
                size="sm"
                className="size-5 justify-center border-transparent bg-background/15 p-0 text-current"
              >
                <IconCornerDownLeft aria-hidden className="size-3 rtl:-scale-x-100" />
                <span className="sr-only">Enter</span>
              </Kbd>
            </KbdGroup>
            ) : null}
          </Button>
        </span>
      </div>
    </div>
  )
}

function ChecklistGlyph() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-[18px] shrink-0 rtl:-scale-x-100"
    >

      <path d="m3 5 2 2 3-3" className="origin-center transform-fill rtl:-scale-x-100" />
      <path d="m3 14 2 2 3-3" className="origin-center transform-fill rtl:-scale-x-100" />
      <path d="M12 6h9" />
      <path d="M12 15h9" />
    </svg>
  )
}

function DownloadGlyph() {
  return (
    <svg
      aria-hidden
      data-slot="download-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-[18px]"
    >
      <path d="M4 20h16" />
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
    </svg>
  )
}
