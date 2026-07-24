// Lucide-style inline SVG icons — stroked, round caps, sized via `size` prop.
const I = ({ size = 20, children, ...props }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    {...props}
  >
    {children}
  </svg>
)

export const SearchIcon = (p) => (
  <I {...p}>
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.35-4.35" />
  </I>
)

export const SendIcon = (p) => (
  <I {...p}>
    <path d="m22 2-7 20-4-9-9-4Z" />
    <path d="M22 2 11 13" />
  </I>
)

export const ArrowLeftIcon = (p) => (
  <I {...p}>
    <path d="m12 19-7-7 7-7" />
    <path d="M19 12H5" />
  </I>
)

export const CameraIcon = (p) => (
  <I {...p}>
    <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
    <circle cx="12" cy="13" r="3" />
  </I>
)

export const SmilePlusIcon = (p) => (
  <I {...p}>
    <path d="M22 11v1a10 10 0 1 1-9-10" />
    <path d="M8 14s1.5 2 4 2 4-2 4-2" />
    <line x1="9" x2="9.01" y1="9" y2="9" />
    <line x1="15" x2="15.01" y1="9" y2="9" />
    <path d="M16 5h6" />
    <path d="M19 2v6" />
  </I>
)

export const BellIcon = (p) => (
  <I {...p}>
    <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
  </I>
)

export const BellOffIcon = (p) => (
  <I {...p}>
    <path d="M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5" />
    <path d="M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7" />
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    <path d="m2 2 20 20" />
  </I>
)

export const LogOutIcon = (p) => (
  <I {...p}>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="m16 17 5-5-5-5" />
    <path d="M21 12H9" />
  </I>
)

export const MessageIcon = (p) => (
  <I {...p}>
    <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
  </I>
)

export const TrashIcon = (p) => (
  <I {...p}>
    <path d="M3 6h18" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </I>
)

export const ImageIcon = (p) => (
  <I {...p}>
    <rect width="18" height="18" x="3" y="3" rx="2" />
    <circle cx="9" cy="9" r="2" />
    <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
  </I>
)

// "look closer at this" — the affordance for the explainability panel
export const ScanEyeIcon = (p) => (
  <I {...p}>
    <path d="M3 7V5a2 2 0 0 1 2-2h2" />
    <path d="M17 3h2a2 2 0 0 1 2 2v2" />
    <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
    <path d="M7 21H5a2 2 0 0 1-2-2v-2" />
    <circle cx="12" cy="12" r="1" />
    <path d="M18.944 12.33a1 1 0 0 0 0-.66 7.5 7.5 0 0 0-13.888 0 1 1 0 0 0 0 .66 7.5 7.5 0 0 0 13.888 0" />
  </I>
)

export const XIcon = (p) => (
  <I {...p}>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </I>
)

// Message status ticks. Both checks are always in the DOM; CSS slides the second
// one in on `delivered` and recolors on `read`, so status changes animate smoothly.
export function Ticks({ status }) {
  if (status === 'pending') {
    return (
      <svg className="ticks pending" width="13" height="13" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-label="sending">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </svg>
    )
  }
  return (
    <svg className={`ticks ${status}`} width="19" height="12" viewBox="0 0 23 12" fill="none"
      stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-label={status}>
      <path className="tick tick-1" d="M1.5 6.5 5.2 10 12.5 2" />
      <path className="tick tick-2" d="M9.5 6.5 13.2 10 20.5 2" />
    </svg>
  )
}
