// Placeholder for the edit-trade form, in TradeForm's own shape.
//
// Editing a trade fetches the row before it can prefill the form, and
// that wait showed the full-screen bars - so tapping Edit on a phone
// blanked the screen, then replaced it with a long form. The form's
// skeleton is worth having precisely because its shape does NOT depend on
// the data: every trade gets the same three sections and the same fields,
// so unlike a list there is no row count to guess wrong.
//
// Mirrors the real grid: .panel > form.trade-form, a 6-column grid where
// .field.full spans 6 and .field.half spans 3, with a .section-label
// opening each of the three sections. Each field is a label bar over a
// control-height block, which is what a .field's own flex column renders.
//
// Rendered at every width because the form itself is - one panel, one
// grid, the same fields on a phone and a laptop.
function Field({ half = false, control = 38 }) {
  return (
    <div className={half ? 'field half' : 'field full'} aria-hidden="true">
      <span className="skel skel-cell" style={{ width: '62px', height: '9px' }} />
      <span className="skel" style={{ display: 'block', height: `${control}px`, borderRadius: '7px' }} />
    </div>
  )
}

function SectionLabel({ width }) {
  return (
    <div className="field full section-label" aria-hidden="true">
      <span className="skel skel-cell" style={{ width, height: '11px' }} />
    </div>
  )
}

export default function TradeFormSkeleton() {
  return (
    <div className="page-container">
      {/* Back link over title, which is what the edit page actually has -
          it carries no subtitle. The first attempt used the usual
          title+subtitle pair and put the panel 15px too high, so the whole
          form stepped down the moment it loaded. The back-link bar is its
          real 15px line box; the title uses .skel-title, which now matches
          .page-title's real 28px. */}
      {/* inline-block, like the real .back-link: an inline-level box sits
          on a line box, whose strut adds ~4px of leading above it that a
          block-level bar does not get. Missing that put the whole form 4px
          high. */}
      <div className="skel" style={{ display: 'inline-block', width: '78px', height: '15px', marginBottom: '14px' }} />
      <div className="skel skel-title" style={{ marginTop: '4px' }} />
      <div className="panel">
        <div className="trade-form">
          {/* Setup: strategy and date side by side, then entry/stop/target
              as the half-width pairs the real form lays them out in. */}
          <SectionLabel width="46px" />
          <Field half />
          <Field half />
          <Field half />
          <Field half />

          {/* Execution. The real section carries the exit legs, which can
              be one row or several - one is skeletoned, since a trade with
              extra exits is the exception. */}
          <SectionLabel width="68px" />
          <Field half />
          <Field half />
          <Field half />
          <Field half />

          {/* Review: reasoning is a textarea, so it gets a taller block
              than the inputs above rather than the same 38px. */}
          <SectionLabel width="52px" />
          <Field control={84} />
        </div>
      </div>
    </div>
  )
}
