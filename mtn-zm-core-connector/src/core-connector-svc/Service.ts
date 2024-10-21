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
- Niza Tembo <mcwayzj@gmail.com>

--------------
******/

'use strict';

import { Server } from '@hapi/hapi';
import { IHTTPClient } from '../domain';
import { CoreConnectorAggregate } from '../domain';
import { AxiosClientFactory } from '../infra/axiosHttpClient';
import config from '../config';
import { CoreConnectorRoutes } from './sdkCoreConnectorRoutes';
import { loggerFactory } from '../infra/logger';
import { createPlugins } from '../plugins';
import { SDKClientFactory } from '../domain/SDKClient';
import { DFSPCoreConnectorRoutes } from './dfspCoreConnectorRoutes';
import { MTNClientFactory } from 'src/domain/CBSClient/MTNClientFactory';

export const logger = loggerFactory({ context: 'MTN CC' });

export class Service {
    static coreConnectorAggregate: CoreConnectorAggregate;
    static httpClient: IHTTPClient;
    static sdkServer: Server;
    static dfspServer: Server;

    static async start(httpClient: IHTTPClient = AxiosClientFactory.createAxiosClientInstance()) {
        this.httpClient = httpClient;
        const mtnConfig = config.get('mtn');
        const mtnClient = MTNClientFactory.createClient({
            mtnConfig: mtnConfig,
            httpClient: this.httpClient,
            logger: logger,
        });

        const sdkClient = SDKClientFactory.getSDKClientInstance(
            logger,
            httpClient,
            config.get('sdkSchemeAdapter.SDK_BASE_URL'),
        );
        this.coreConnectorAggregate = new CoreConnectorAggregate(sdkClient, mtnClient, mtnConfig, logger);

        await this.setupAndStartUpServer();
        logger.info('Core Connector Server started');
    }

    static async setupAndStartUpServer() {
        this.sdkServer = new Server({
            host: config.get('server.SDK_SERVER_HOST'),
            port: config.get('server.SDK_SERVER_PORT'),
        });

        this.dfspServer = new Server({
            host: config.get('server.DFSP_SERVER_HOST'),
            port: config.get('server.DFSP_SERVER_PORT'),
        });
        await this.sdkServer.register(createPlugins({ logger }));

        await this.dfspServer.register(createPlugins({ logger }));

        const coreConnectorRoutes = new CoreConnectorRoutes(this.coreConnectorAggregate, logger);
        await coreConnectorRoutes.init();

        const dfspCoreConnectorRoutes = new DFSPCoreConnectorRoutes(this.coreConnectorAggregate, logger);
        await dfspCoreConnectorRoutes.init();

        this.sdkServer.route(coreConnectorRoutes.getRoutes());
        this.dfspServer.route(dfspCoreConnectorRoutes.getRoutes());

        await this.sdkServer.start();
        logger.info(`Mojaloop Connector Core Connector Server running at ${this.sdkServer.info.uri}`);
        await this.dfspServer.start();
        logger.info(`DFSP Core Connector Server running at ${this.dfspServer.info.uri}`);
    }

    static async stop() {
        await this.sdkServer.stop({ timeout: 60 });
        await this.dfspServer.stop({ timeout: 60 });
        logger.info('Service Stopped');
    }
}
