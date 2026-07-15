interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * CNPJ Brazil MCP — Brazilian company-registry (Receita Federal) lookup via
 * minhareceita.org, an open mirror of the Receita Federal CNPJ open-data dumps.
 *
 * Tools:
 * - cnpj_lookup: full company registration by CNPJ — legal name, status,
 *   activity (CNAE), address, capital, size, Simples/MEI flags, partners (QSA)
 *
 * Keyless — no auth, no API key. Data source refreshes from the monthly
 * Receita Federal open-data releases, so very recent registrations or
 * changes may lag by a few weeks.
 *
 * Upstream quirks (probed 2026-07-15):
 * - 400 {"message":"CNPJ xx.xxx.xxx/xxxx-xx inválido."} on bad check digits
 * - 404 {"message":"... não encontrado."} on valid-checksum-but-unregistered
 * - Punctuated CNPJs in the URL path are accepted upstream, but we strip
 *   to digits ourselves for predictable errors.
 */


const BASE_URL = 'https://minhareceita.org';

const tools: McpToolExport['tools'] = [
  {
    name: 'cnpj_lookup',
    description:
      'Look up a Brazilian company in the CNPJ registry (Receita Federal, Brazil\'s federal tax authority) — the primary KYB / due-diligence check for any Brazil company. Give a 14-digit CNPJ (punctuation ok: "33.683.111/0002-80") and get legal name (razão social), trade name, registration status, opening date, legal nature, main CNAE activity, address, share capital, company size, Simples Nacional / MEI tax-regime flags, and the partner/officer list (QSA) with roles. Example: cnpj_lookup({ cnpj: "33683111000280" })',
    inputSchema: {
      type: 'object' as const,
      properties: {
        cnpj: {
          type: 'string',
          description:
            'The company\'s CNPJ — 14 digits, with or without punctuation, e.g. "33.683.111/0002-80" or "33683111000280"',
        },
      },
      required: ['cnpj'],
    },
  },
  // (checksum-only validation deliberately lives in latam-validate's
  // validate_cnpj — this pack only carries the registry lookup, so the
  // router has exactly one home for each intent.)
];

// ---------------------------------------------------------------------------
// CNPJ helpers

/** Strip everything that isn't a digit: "33.683.111/0002-80" → "33683111000280". */
function stripCnpj(raw: unknown): string {
  return String(raw ?? '').replace(/\D/g, '');
}

function formatCnpj(d: string): string {
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}

/** Standard CNPJ mod-11 check digit over the given digits/weights. */
function checkDigit(digits: number[], weights: number[]): number {
  const sum = digits.reduce((acc, d, i) => acc + d * weights[i], 0);
  const rem = sum % 11;
  return rem < 2 ? 0 : 11 - rem;
}

function validateChecksum(cnpj: string): { valid: boolean; reason?: string } {
  if (!/^\d{14}$/.test(cnpj)) {
    return {
      valid: false,
      reason: `A CNPJ has exactly 14 digits; got ${cnpj.length} after stripping punctuation.`,
    };
  }
  if (/^(\d)\1{13}$/.test(cnpj)) {
    return {
      valid: false,
      reason: 'All-same-digit CNPJs (e.g. 00.000.000/0000-00) are invalid by definition.',
    };
  }
  const digits = [...cnpj].map(Number);
  const d1 = checkDigit(digits.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = checkDigit(digits.slice(0, 13), [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  if (digits[12] !== d1 || digits[13] !== d2) {
    return {
      valid: false,
      reason: `Check digits don't match: expected ...${d1}${d2}, got ...${digits[12]}${digits[13]}. Likely a typo in the number.`,
    };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// minhareceita.org response shape (fields verified by live probe)

interface MinhaReceitaPartner {
  nome_socio: string;
  qualificacao_socio: string;
  faixa_etaria: string;
  data_entrada_sociedade: string | null;
}

interface MinhaReceitaCompany {
  cnpj: string;
  razao_social: string;
  nome_fantasia: string | null;
  descricao_situacao_cadastral: string;
  data_situacao_cadastral: string | null;
  descricao_motivo_situacao_cadastral: string | null;
  descricao_identificador_matriz_filial: string | null;
  data_inicio_atividade: string | null;
  natureza_juridica: string | null;
  cnae_fiscal: number | null;
  cnae_fiscal_descricao: string | null;
  cnaes_secundarios: Array<{ codigo: number; descricao: string }> | null;
  descricao_tipo_de_logradouro: string | null;
  logradouro: string | null;
  numero: string | null;
  complemento: string | null;
  bairro: string | null;
  municipio: string | null;
  uf: string | null;
  cep: string | null;
  capital_social: number | null;
  porte: string | null;
  opcao_pelo_simples: boolean | null;
  opcao_pelo_mei: boolean | null;
  email: string | null;
  ddd_telefone_1: string | null;
  qsa: MinhaReceitaPartner[] | null;
}

function shapeCompany(c: MinhaReceitaCompany) {
  const secondary = c.cnaes_secundarios ?? [];
  const partners = c.qsa ?? [];
  const street = [c.descricao_tipo_de_logradouro, c.logradouro].filter(Boolean).join(' ');
  return {
    cnpj: c.cnpj,
    formatted: formatCnpj(c.cnpj),
    company_name: c.razao_social,
    trade_name: c.nome_fantasia || null,
    status: c.descricao_situacao_cadastral, // ATIVA, BAIXADA, SUSPENSA, INAPTA, NULA
    status_date: c.data_situacao_cadastral,
    status_reason:
      c.descricao_motivo_situacao_cadastral && c.descricao_motivo_situacao_cadastral !== 'SEM MOTIVO'
        ? c.descricao_motivo_situacao_cadastral
        : undefined,
    unit_type: c.descricao_identificador_matriz_filial, // MATRIZ (HQ) or FILIAL (branch)
    opened_date: c.data_inicio_atividade,
    legal_nature: c.natureza_juridica,
    main_activity: { code: c.cnae_fiscal, description: c.cnae_fiscal_descricao },
    secondary_activities_count: secondary.length,
    secondary_activities: secondary
      .slice(0, 5)
      .map((s) => ({ code: s.codigo, description: s.descricao })),
    address: [street, c.numero, c.complemento, c.bairro].filter(Boolean).join(', ') || null,
    city: c.municipio,
    state: c.uf,
    zip_code: c.cep,
    share_capital: c.capital_social, // capital social, in BRL
    size: c.porte, // MICRO EMPRESA, EMPRESA DE PEQUENO PORTE, DEMAIS
    simples_nacional: c.opcao_pelo_simples, // simplified tax regime opt-in (null = not reported)
    mei: c.opcao_pelo_mei, // micro-entrepreneur regime opt-in (null = not reported)
    email: c.email || null,
    phone: c.ddd_telefone_1 || null,
    partner_count: partners.length,
    partners: partners.map((p) => ({
      name: p.nome_socio,
      role: p.qualificacao_socio, // e.g. Diretor, Sócio-Administrador — Receita Federal wording
      age_bracket: p.faixa_etaria, // e.g. "Entre 41 a 50 anos"
      joined_date: p.data_entrada_sociedade,
    })),
    source:
      'minhareceita.org — open mirror of Receita Federal CNPJ open data (refreshed from monthly official dumps)',
  };
}

// ---------------------------------------------------------------------------
// Tool implementations

function requireCnpj(raw: unknown, tool: string): string {
  const digits = stripCnpj(raw);
  if (digits.length !== 14) {
    throw new Error(
      `${tool}: a CNPJ has exactly 14 digits — got ${digits.length} after stripping punctuation from "${String(raw ?? '')}". Example: "33.683.111/0002-80" or "33683111000280".`,
    );
  }
  return digits;
}

async function cnpjLookup(args: Record<string, unknown>) {
  const cnpj = requireCnpj(args.cnpj, 'cnpj_lookup');
  const res = await fetch(`${BASE_URL}/${cnpj}`, { headers: { Accept: 'application/json' } });

  if (res.status === 400) {
    // Upstream rejects bad check digits with {"message":"CNPJ ... inválido."}
    const check = validateChecksum(cnpj);
    throw new Error(
      `CNPJ ${formatCnpj(cnpj)} is not a valid CNPJ number. ${check.reason ?? 'The check digits fail the mod-11 checksum — likely a typo.'} Checksum validation also lives in latam-validate's validate_cnpj.`,
    );
  }
  if (res.status === 404) {
    throw new Error(
      `CNPJ ${formatCnpj(cnpj)} was not found in the Receita Federal registry mirror. The checksum is ${validateChecksum(cnpj).valid ? 'valid, so this is either an unregistered number or a registration newer than the latest monthly data dump' : 'also invalid — likely a typo'}.`,
    );
  }
  if (res.status === 429 || res.status >= 500) {
    throw new Error(
      `minhareceita.org (the open Receita Federal CNPJ mirror) returned HTTP ${res.status} — the free public service is temporarily rate-limited or down. Retry in a few seconds.`,
    );
  }
  if (!res.ok) {
    throw new Error(`cnpj_lookup: minhareceita.org returned unexpected HTTP ${res.status}.`);
  }
  const data = (await res.json()) as MinhaReceitaCompany;
  return shapeCompany(data);
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'cnpj_lookup':
      return cnpjLookup(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool } satisfies McpToolExport;
