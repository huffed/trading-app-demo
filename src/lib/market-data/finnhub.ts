const BASE_URL = "https://finnhub.io/api/v1";

function getApiKey(): string {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) throw new Error("FINNHUB_API_KEY is not set");
  return key;
}

interface CompanyProfile {
  ticker: string;
  name: string;
  finnhubIndustry: string;
  marketCapitalization: number;
  country: string;
  exchange: string;
  ipo: string;
  logo: string;
  weburl: string;
}

export interface CompanyInfo {
  ticker: string;
  name: string;
  sector: string;
  marketCap: number;
  country: string;
  exchange: string;
}

export async function getCompanyProfile(
  symbol: string
): Promise<CompanyInfo | null> {
  try {
    const url = `${BASE_URL}/stock/profile2?symbol=${encodeURIComponent(symbol)}&token=${getApiKey()}`;
    const res = await fetch(url);
    if (!res.ok) return null;

    const data = (await res.json()) as CompanyProfile;
    if (!data.name) return null;

    return {
      ticker: data.ticker || symbol,
      name: data.name,
      sector: data.finnhubIndustry || "",
      marketCap: data.marketCapitalization || 0,
      country: data.country || "",
      exchange: data.exchange || "",
    };
  } catch {
    return null;
  }
}

export async function lookupTickerName(symbol: string): Promise<string> {
  const profile = await getCompanyProfile(symbol);
  return profile?.name ?? "";
}
