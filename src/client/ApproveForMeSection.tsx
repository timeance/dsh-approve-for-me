import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from 'react'
import type {
  InjectFace,
  PropsLocale,
  PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import {
  buildSettingsMutation,
  createSettingsDraft,
  isReviewerRouteAvailable,
  sameEditableSettings,
  type SettingsDraft,
  validateSettingsDraft,
} from './settings-form.ts'
import type { CommandPrefixRuleError } from './rules.ts'
import type {
  ApproveForMeSettings,
  ApproveForMeSettingsState,
} from './settings-types.ts'
import type { SnapshotStore } from './snapshot-store.ts'
import type { SettingsLocaleKey } from './settings-locale.ts'
import styles from './ApproveForMeSettingsSection.module.css'

const css = styles as Record<
  | 'card' | 'disclosure' | 'cardHeader' | 'cardHeading' | 'cardDescription'
  | 'section' | 'header' | 'summary' | 'hint' | 'description' | 'status'
  | 'notice' | 'error' | 'success' | 'errorTitle' | 'fieldGroup'
  | 'legend' | 'modeGrid' | 'modelGrid' | 'modeCard' | 'modeText'
  | 'label' | 'select' | 'textarea' | 'inlineError' | 'errorList'
  | 'actions' | 'button' | 'secondaryButton',
  string
>

export interface ApproveForMeSectionInjected {
  hooks: {
    approveForMe: SnapshotStore<ApproveForMeSettingsState>
  }
  load: () => Promise<void>
  save: (settings: ApproveForMeSettings) => Promise<void>
  reset: () => Promise<void>
}

export type ApproveForMeSectionProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.approve-for-me'>
  & InjectFace<ApproveForMeSectionInjected>

function ruleMessage(
  error: CommandPrefixRuleError,
  t: (key: SettingsLocaleKey, params?: Record<string, string | number>) => string,
): string {
  if (error.code === 'control-character') {
    return t('ruleControlCharacter', { line: error.line })
  }
  if (error.code === 'too-long') {
    return t('ruleTooLong', { line: error.line })
  }
  if (error.code === 'duplicate') {
    return t('ruleDuplicate', {
      line: error.line,
      firstLine: error.firstLine,
    })
  }
  return t('ruleInvalid', { line: error.line, reason: error.reason })
}

function ErrorList({
  errors,
  id,
  t,
}: {
  errors: readonly CommandPrefixRuleError[]
  id: string
  t: (key: SettingsLocaleKey, params?: Record<string, string | number>) => string
}): ReactNode {
  if (errors.length === 0) return null
  return (
    <ul className={css.errorList} id={id}>
      {errors.map(error => (
        <li key={error.code + ':' + error.line}>{ruleMessage(error, t)}</li>
      ))}
    </ul>
  )
}

/** Render the nested approve-for-me settings namespace. */
export function ApproveForMeSection(
  props: ApproveForMeSectionProps,
): ReactNode {
  const { load, reset, save, t, useApproveForMe } = props
  const state = useApproveForMe(snapshot => snapshot)
  const [draft, setDraft] = useState<SettingsDraft | undefined>(
    state.value === undefined ? undefined : createSettingsDraft(state.value),
  )
  const [actionError, setActionError] = useState<string>()
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (state.value === undefined) {
      setDraft(undefined)
      return
    }
    setDraft(createSettingsDraft(state.value))
  }, [state.value])

  const validation = useMemo(() => (
    draft === undefined
      ? { provider: undefined, model: undefined, shellRules: [], pwshRules: [] } as const
      : validateSettingsDraft(draft, state.modelGroups, state.value)
  ), [draft, state.modelGroups, state.value])

  const selectedProvider = state.modelGroups.find(group =>
    group.id === draft?.provider)
  const normalized = draft === undefined || state.value === undefined
    ? undefined
    : buildSettingsMutation(draft, state.value)
  const dirty = state.value !== undefined
    && normalized !== undefined
    && !sameEditableSettings(state.value, normalized)
  const hasErrors = validation.provider !== undefined
    || validation.model !== undefined
    || validation.shellRules.length > 0
    || validation.pwshRules.length > 0
  const reviewerMissing = draft?.mode === 'rules-and-llm'
    && state.modelsStatus !== 'idle'
    && state.modelsStatus !== 'loading'
    && !isReviewerRouteAvailable(draft, state.modelGroups)
  const busy = state.status === 'loading'
    || state.status === 'saving'
    || state.status === 'resetting'

  const setField = <Key extends keyof SettingsDraft>(
    key: Key,
    value: SettingsDraft[Key],
  ): void => {
    setSaved(false)
    setActionError(undefined)
    setDraft(current => current === undefined
      ? current
      : { ...current, [key]: value })
  }

  const setMode = (mode: SettingsDraft['mode']): void => {
    setSaved(false)
    setActionError(undefined)
    setDraft(current => current === undefined
      ? current
      : { ...current, mode })
  }

  const setProvider = (providerId: string): void => {
    const provider = state.modelGroups.find(group => group.id === providerId)
    setSaved(false)
    setActionError(undefined)
    setDraft(current => current === undefined
      ? current
      : {
          ...current,
          provider: providerId,
          model: provider?.models[0]?.id ?? '',
        })
  }

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (
      draft === undefined
      || state.value === undefined
      || !state.writable
      || busy
      || hasErrors
    ) return
    try {
      await save(buildSettingsMutation(draft, state.value))
      setActionError(undefined)
      setSaved(true)
    } catch (error) {
      setSaved(false)
      setActionError(error instanceof Error ? error.message : t('actionError'))
    }
  }

  const restore = async (): Promise<void> => {
    if (!state.writable || busy) return
    try {
      await reset()
      setActionError(undefined)
      setSaved(false)
    } catch (error) {
      setSaved(false)
      setActionError(error instanceof Error ? error.message : t('actionError'))
    }
  }

  if (state.status === 'loading' && draft === undefined) {
    return (
      <li className={css.card}>
        <p className={css.status}>{t('loading')}</p>
      </li>
    )
  }

  if (state.status === 'unavailable') {
    return null
  }

  if (draft === undefined) {
    return (
      <li className={css.card}>
        <div className={css.error} role="alert">
          <p className={css.errorTitle}>{t('loadError')}</p>
          {state.error === null ? null : <p>{state.error}</p>}
          <button className={css.secondaryButton} onClick={() => void load()} type="button">
            {t('retry')}
          </button>
        </div>
      </li>
    )
  }

  return (
    <li className={css.card}>
      <details className={css.disclosure}>
        <summary className={css.cardHeader}>
          <span className={css.cardHeading}>
            <strong>{t('title')}</strong>
            <span className={css.cardDescription}>{t('summary')}</span>
          </span>
          <span aria-hidden="true">▾</span>
        </summary>
        <form className={css.section} onSubmit={event => void submit(event)}>

      {!state.writable ? (
        <div className={css.notice} role="status">{t('readOnly')}</div>
      ) : null}
      {state.error === null ? null : (
        <div className={css.error} role="alert">
          <p className={css.errorTitle}>{t('loadError')}</p>
          <p>{state.error}</p>
          <button className={css.secondaryButton} onClick={() => void load()} type="button">
            {t('retry')}
          </button>
        </div>
      )}
      {state.modelsError === null ? null : (
        <div className={css.error} role="alert">
          <p className={css.errorTitle}>{t('modelCatalogError')}</p>
          <p>{state.modelsError}</p>
        </div>
      )}
      {state.modelFailures.length === 0 ? null : (
        <div className={css.notice} role="status">
          {state.modelFailures.map(failure => <div key={failure}>{failure}</div>)}
        </div>
      )}
      {reviewerMissing ? (
        <div className={css.error} role="alert">{t('missingReviewer')}</div>
      ) : null}
      {actionError === undefined ? null : (
        <div className={css.error} role="alert">{actionError}</div>
      )}
      {saved ? <div className={css.success} role="status">{t('saved')}</div> : null}

      <fieldset className={css.fieldGroup} disabled={!state.writable || busy}>
        <legend className={css.legend}>{t('mode')}</legend>
        <div className={css.modeGrid}>
          <label className={css.modeCard}>
            <input
              checked={draft.mode === 'rules-only'}
              name="approve-for-me-mode"
              onChange={() => setMode('rules-only')}
              type="radio"
            />
            <span className={css.modeText}>
              <strong>{t('rulesOnly')}</strong>
              <span className={css.description}>{t('rulesOnlyDescription')}</span>
            </span>
          </label>
          <label className={css.modeCard}>
            <input
              checked={draft.mode === 'rules-and-llm'}
              name="approve-for-me-mode"
              onChange={() => setMode('rules-and-llm')}
              type="radio"
            />
            <span className={css.modeText}>
              <strong>{t('rulesAndLlm')}</strong>
              <span className={css.description}>{t('rulesAndLlmDescription')}</span>
            </span>
          </label>
        </div>
      </fieldset>

      {draft.mode === 'rules-and-llm' ? (
        <fieldset className={css.fieldGroup} disabled={!state.writable || busy}>
          <legend className={css.legend}>{t('provider')}</legend>
          <p className={css.description}>
            {draft.provider === '' && draft.model === ''
              ? t('currentSessionDescription')
              : t('explicitRouteDescription')}
          </p>
          <div className={css.modelGrid}>
            <label className={css.label}>
              {t('provider')}
              <select
                aria-label={t('provider')}
                className={css.select}
                onChange={event => setProvider(event.target.value)}
                value={draft.provider}
              >
                <option value="">{t('currentSession')}</option>
                {selectedProvider === undefined && draft.provider !== '' ? (
                  <option value={draft.provider}>
                    {draft.provider + ' - ' + t('unavailableProvider')}
                  </option>
                ) : null}
                {state.modelGroups.map(group => (
                  <option key={group.id} value={group.id}>{group.name}</option>
                ))}
              </select>
              {validation.provider === undefined ? null : (
                <span className={css.inlineError}>{t('providerRequired')}</span>
              )}
            </label>
            <label className={css.label}>
              {t('model')}
              <select
                aria-label={t('model')}
                className={css.select}
                disabled={draft.provider === ''}
                onChange={event => setField('model', event.target.value)}
                value={draft.model}
              >
                {draft.model === '' ? (
                  <option value="">
                    {draft.provider === '' ? t('currentSession') : t('modelRequired')}
                  </option>
                ) : null}
                {draft.model !== ''
                  && !selectedProvider?.models.some(model => model.id === draft.model) ? (
                    <option value={draft.model}>
                      {draft.model + ' - ' + t('unavailableModel')}
                    </option>
                  ) : null}
                {(selectedProvider?.models ?? []).map(model => (
                  <option key={model.id} value={model.id}>{model.name}</option>
                ))}
              </select>
              {validation.model === undefined ? null : (
                <span className={css.inlineError}>{t('modelRequired')}</span>
              )}
            </label>
          </div>
          {draft.provider !== '' && state.modelGroups.length === 0 && state.modelsStatus !== 'loading' ? (
            <p className={css.hint}>{t('noProviders')}</p>
          ) : selectedProvider?.models.length === 0 ? (
            <p className={css.hint}>{t('noModels')}</p>
          ) : null}
        </fieldset>
      ) : null}

      <fieldset className={css.fieldGroup} disabled={!state.writable || busy}>
        <legend className={css.legend}>{t('shellRules')}</legend>
        <p className={css.description}>{t('shellRulesDescription')}</p>
        <textarea
          aria-label={t('shellRules')}
          aria-describedby="approve-for-me-shell-help approve-for-me-shell-errors"
          className={css.textarea}
          onChange={event => setField('shellRulesText', event.target.value)}
          placeholder={t('shellRulesPlaceholder')}
          spellCheck={false}
          value={draft.shellRulesText}
        />
        <p className={css.hint} id="approve-for-me-shell-help">{t('commentHelp')}</p>
        <ErrorList errors={validation.shellRules} id="approve-for-me-shell-errors" t={t} />
      </fieldset>

      <fieldset className={css.fieldGroup} disabled={!state.writable || busy}>
        <legend className={css.legend}>{t('pwshRules')}</legend>
        <p className={css.description}>{t('pwshRulesDescription')}</p>
        <textarea
          aria-label={t('pwshRules')}
          aria-describedby="approve-for-me-pwsh-help approve-for-me-pwsh-errors"
          className={css.textarea}
          onChange={event => setField('pwshRulesText', event.target.value)}
          placeholder={t('pwshRulesPlaceholder')}
          spellCheck={false}
          value={draft.pwshRulesText}
        />
        <p className={css.hint} id="approve-for-me-pwsh-help">{t('commentHelp')}</p>
        <ErrorList errors={validation.pwshRules} id="approve-for-me-pwsh-errors" t={t} />
      </fieldset>

      {draft.mode === 'rules-and-llm' ? (
        <fieldset className={css.fieldGroup} disabled={!state.writable || busy}>
          <legend className={css.legend}>{t('instructions')}</legend>
          <p className={css.description}>{t('instructionsDescription')}</p>
          <textarea
            aria-label={t('instructions')}
            className={css.textarea}
            onChange={event => setField('reviewerInstructions', event.target.value)}
            placeholder={t('instructionsPlaceholder')}
            value={draft.reviewerInstructions}
          />
        </fieldset>
      ) : null}

      <div className={css.actions}>
        <button
          className={css.button}
          disabled={!state.writable || busy || hasErrors || !dirty}
          type="submit"
        >
          {state.status === 'saving' ? t('saving') : t('save')}
        </button>
        <button
          className={css.secondaryButton}
          disabled={!state.writable || busy}
          onClick={() => void restore()}
          type="button"
        >
          {state.status === 'resetting' ? t('resetting') : t('reset')}
        </button>
        {dirty ? <span className={css.status}>{t('unsaved')}</span> : null}
        </div>
        </form>
      </details>
    </li>
  )
}
