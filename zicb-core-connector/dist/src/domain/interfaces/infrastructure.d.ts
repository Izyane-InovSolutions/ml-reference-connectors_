/*****
 License
--------------
Copyright © 2017 Bill & Melinda Gates Foundation
The Mojaloop files are made available by the Bill & Melinda Gates Foundation under the Apache License, Version 2.0 (the "License") and you may not use these files except in compliance with the License. You may obtain a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, the Mojaloop files are distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.

Contributors
--------------
This is the official list (alphabetical ordering) of the Mojaloop project contributors for this file.
Names of the original copyright holders (individuals or organizations)
should be listed with a '*' in the first column. People who have
contributed from an organization can be listed under the organization
that actually holds the copyright for their contributions (see the
Gates Foundation organization for an example). Those individuals should have
their names indented and be marked with a '-'. Email address can be added
optionally within square brackets <email>.


- Okello Ivan Elijah <elijahokello90@gmail.com>

--------------
******/
import { THttpRequestOptions, THttpResponse, TJson } from './types';
import { AxiosRequestConfig } from 'axios';
export interface IHTTPClient {
    get<R = unknown>(url: string, options?: THttpRequestOptions): Promise<THttpResponse<R>>;
    post<D extends TJson, R = unknown>(url: string, data: D, options?: THttpRequestOptions): Promise<THttpResponse<R>>;
    put<D extends TJson, R = unknown>(url: string, data: D, options?: THttpRequestOptions): Promise<THttpResponse<R>>;
    send<R = unknown>(options: AxiosRequestConfig): Promise<THttpResponse<R>>;
}
export type TLogMethod = (message: string | Error, meta?: any) => void;
export interface ILogger {
    error: TLogMethod;
    warn: TLogMethod;
    trace: TLogMethod;
    info: TLogMethod;
    verbose: TLogMethod;
    debug: TLogMethod;
    silly: TLogMethod;
    child(context?: TJson): ILogger;
}
