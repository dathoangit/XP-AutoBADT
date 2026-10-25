export interface AuthPayload {
  access_token: string;
  refresh_token?: string;
  username?: string;
  refreshTime?: number;
  [key: string]: unknown;
}
