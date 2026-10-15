/** The Studio Sky mark (#33): one amber node linked to two grey ones. The favicon in index.html draws the same shape. */
export function BrandMark() {
  return (
    <svg className="brand__mark" aria-hidden="true" width="22" height="22" viewBox="0 0 26 26" fill="none">
      <circle cx="5" cy="19" r="3" fill="#FFB547" /><circle cx="20" cy="6" r="2.2" fill="#C9CBCF" /><circle cx="21" cy="20" r="1.6" fill="#C9CBCF" />
      <path d="M5 19L20 6M5 19L21 20" stroke="#4A4F59" strokeWidth="1" />
    </svg>
  )
}
