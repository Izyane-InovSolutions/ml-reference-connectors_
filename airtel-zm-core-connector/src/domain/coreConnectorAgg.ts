/*****
 License
 --------------
 Copyright © 2020-2024 Mojaloop Foundation
 The Mojaloop files are made available by the Mojaloop Foundation under the Apache License, Version 2.0 (the "License") and you may not use these files except in compliance with the License. You may obtain a copy of the License at
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
- Kasweka Michael Mukoko <kaswekamukoko@gmail.com>
 - Niza Tembo <mcwayzj@gmail.com>

 --------------
 ******/

'use strict';

import { randomUUID } from 'crypto';
import {
    PartyType,
    IAirtelClient,
    TAirtelDisbursementRequestBody,
    TAirtelConfig,
    TAirtelUpdateSendMoneyRequest,
    TAirtelCollectMoneyRequest,
    AirtelError,
    TCallbackRequest,
    TAirtelCollectMoneyResponse,
} from './CBSClient';
import {
    ILogger,
    TLookupPartyInfoResponse,
    TQuoteResponse,
    TQuoteRequest,
    TtransferResponse,
    TtransferRequest,
    ValidationError,
    TtransferPatchNotificationRequest,
    THttpResponse,
} from './interfaces';
import {
    ISDKClient,
    SDKClientError,
    TSDKOutboundTransferRequest,
    TSDKOutboundTransferResponse,
    TtransferContinuationResponse,
} from './SDKClient';
import {
    TAirtelSendMoneyRequest,
    TAirtelSendMoneyResponse,
} from './CBSClient';
import config from '../config';

export class CoreConnectorAggregate {
    public IdType: string;
    private logger: ILogger;
    DATE_FORMAT = 'dd MM yy';

    constructor(
        private readonly sdkClient: ISDKClient,
        private readonly airtelConfig: TAirtelConfig,
        private readonly airtelClient: IAirtelClient,
        logger: ILogger,
    ) {
        this.IdType = airtelConfig.SUPPORTED_ID_TYPE;
        this.logger = logger;
    }

    async getParties(id: string, idType: string): Promise<TLookupPartyInfoResponse> {
        this.logger.info(`Get Parties for ${id}`);
        if (!(idType === config.get("airtel.SUPPORTED_ID_TYPE"))) {
            throw ValidationError.unsupportedIdTypeError();
        }

        const lookupRes = await this.airtelClient.getKyc({ msisdn: id });
        const party = {
            data: {
                displayName: `${lookupRes.data.first_name} ${lookupRes.data.last_name}`,
                firstName: lookupRes.data.first_name,
                idType: config.get("airtel.SUPPORTED_ID_TYPE"),
                idValue: id,
                lastName: lookupRes.data.last_name,
                middleName: lookupRes.data.first_name,
                type: PartyType.CONSUMER,
                kycInformation: `${JSON.stringify(lookupRes)}`,
            },
            statusCode: Number(lookupRes.status.code),
        };
        this.logger.info(`Party found`, { party });
        return party;
    }

    async quoteRequest(quoteRequest: TQuoteRequest): Promise<TQuoteResponse> {
        this.logger.info(`Quote requests for ${this.IdType} ${quoteRequest.to.idValue}`);
        if (quoteRequest.to.idType !== this.IdType) {
            throw ValidationError.unsupportedIdTypeError();
        }

        if (quoteRequest.currency !== config.get("airtel.X_CURRENCY")) {
            throw ValidationError.unsupportedCurrencyError();
        }

        const res = await this.airtelClient.getKyc({
            msisdn: quoteRequest.to.idValue,

        });

        if (res.data.is_barred) {
            throw AirtelError.payeeBlockedError("Account is barred ", 500, "5400");
        }

        const serviceCharge = Number(config.get("airtel.SERVICE_CHARGE"));
        const fees = serviceCharge/100 * Number(quoteRequest.amount);

        await this.checkAccountBarred(quoteRequest.to.idValue);

        const quoteExpiration = config.get("airtel.EXPIRATION_DURATION");
        const expiration = new Date();
        expiration.setHours(expiration.getHours() + Number(quoteExpiration));
        const expirationJSON = expiration.toJSON();

        return {
            expiration: expirationJSON,
            payeeFspCommissionAmount: '0',
            payeeFspCommissionAmountCurrency: quoteRequest.currency,
            payeeFspFeeAmount: fees.toString(),
            payeeFspFeeAmountCurrency: quoteRequest.currency,
            payeeReceiveAmount: quoteRequest.amount,
            payeeReceiveAmountCurrency: quoteRequest.currency,
            quoteId: quoteRequest.quoteId,
            transactionId: quoteRequest.transactionId,
            transferAmount: quoteRequest.amount,
            transferAmountCurrency: quoteRequest.currency,
        };
    }

    private async checkAccountBarred(msisdn: string): Promise<void> {

        const res = await this.airtelClient.getKyc({ msisdn: msisdn });

        if (res.data.is_barred) {
            throw ValidationError.accountBarredError();
        }
    }

    async receiveTransfer(transfer: TtransferRequest): Promise<TtransferResponse> {
        this.logger.info(`Transfer for  ${this.IdType} ${transfer.to.idValue}`);
        if (transfer.to.idType != this.IdType) {
            throw ValidationError.unsupportedIdTypeError();
        }
        if (transfer.currency !== config.get("airtel.X_CURRENCY")) {
            throw ValidationError.unsupportedCurrencyError();
        }
        if (!this.validateQuote(transfer)) {
            throw ValidationError.invalidQuoteError();
        }

        await this.checkAccountBarred(transfer.to.idValue);
        return {
            completedTimestamp: new Date().toJSON(),
            homeTransactionId: transfer.transferId,
            transferState: 'RESERVED',
        };
    }

    private validateQuote(transfer: TtransferRequest): boolean {
        this.logger.info(`Validating quote for transfer with amount ${transfer.amount}`);
        let result = true;
        if (transfer.amountType === 'SEND') {
            if (!this.checkSendAmounts(transfer)) {
                result = false;
            }
        } else if (transfer.amountType === 'RECEIVE') {
            if (!this.checkReceiveAmounts(transfer)) {
                result = false;
            }
        }
        return result;
    }

    private checkSendAmounts(transfer: TtransferRequest): boolean {
        this.logger.info('Validating Type Send Quote...', { transfer });
        let result = true;
        if (
            parseFloat(transfer.amount) !==
            parseFloat(transfer.quote.transferAmount) - parseFloat(transfer.quote.payeeFspCommissionAmount || '0')
            // POST /transfers request.amount == request.quote.transferAmount - request.quote.payeeFspCommissionAmount
        ) {
            result = false;
        }

        if (!transfer.quote.payeeReceiveAmount || !transfer.quote.payeeFspFeeAmount) {
            throw ValidationError.notEnoughInformationError("transfer.quote.payeeReceiveAmount or !transfer.quote.payeeFspFeeAmount not defined", "5000");
        }

        if (
            parseFloat(transfer.quote.payeeReceiveAmount) !==
            parseFloat(transfer.quote.transferAmount) -
            parseFloat(transfer.quote.payeeFspFeeAmount)
        ) {
            result = false;
        }
        return result;
    }

    private checkReceiveAmounts(transfer: TtransferRequest): boolean {
        this.logger.info('Validating Type Receive Quote...', { transfer });
        let result = true;
        if (!transfer.quote.payeeFspFeeAmount || !transfer.quote.payeeReceiveAmount) {
            throw ValidationError.notEnoughInformationError("transfer.quote.payeeFspFeeAmount or transfer.quote.payeeReceiveAmount not defined", "5000");
        }
        if (
            parseFloat(transfer.amount) !==
            parseFloat(transfer.quote.transferAmount) -
            parseFloat(transfer.quote.payeeFspCommissionAmount || '0') +
            parseFloat(transfer.quote.payeeFspFeeAmount)
        ) {
            result = false;
        }

        if (parseFloat(transfer.quote.payeeReceiveAmount) !== parseFloat(transfer.quote.transferAmount)) {
            result = false;
        }
        return result;
    }

    private validatePatchQuote(transfer: TtransferPatchNotificationRequest): boolean {
        this.logger.info(`Validating code for transfer with state ${transfer.currentState}`);
        // todo define implmentation
        return true;
    }

    async updateTransfer(updateTransferPayload: TtransferPatchNotificationRequest, transferId: string): Promise<void> {
        this.logger.info(`Committing The Transfer with id ${transferId}`);
        if (updateTransferPayload.currentState !== 'COMPLETED') {
            throw ValidationError.transferNotCompletedError();
        }
        if (!this.validatePatchQuote(updateTransferPayload)) {
            throw ValidationError.invalidQuoteError();
        }
        const airtelDisbursementRequest: TAirtelDisbursementRequestBody = this.getDisbursementRequestBody(updateTransferPayload);
        await this.airtelClient.sendMoney(airtelDisbursementRequest);
    }


    private getDisbursementRequestBody(requestBody: TtransferPatchNotificationRequest): TAirtelDisbursementRequestBody {
        if (!requestBody.quoteRequest) {
            throw ValidationError.quoteNotDefinedError('Quote Not Defined Error', '5000', 500);
        }
        return {
            "payee": {
                "msisdn": requestBody.quoteRequest.body.payee.partyIdInfo.partyIdentifier,
                "wallet_type": "NORMAL"
            },
            "reference": requestBody.quoteRequest.body.transactionId,
            "pin": this.airtelConfig.AIRTEL_PIN,
            "transaction": {
                "amount": Number(requestBody.quoteRequest.body.amount),
                "id": requestBody.quoteRequest.body.transactionId,
                "type": "B2C"
            }
        };
    }


    async sendTransfer(transfer: TAirtelSendMoneyRequest): Promise<TAirtelSendMoneyResponse> {
        this.logger.info(`Transfer from airtel account with ID${transfer.payerAccount}`);

        const transferRequest: TSDKOutboundTransferRequest = await this.getTSDKOutboundTransferRequest(transfer);
        const res = await this.sdkClient.initiateTransfer(transferRequest);
        let acceptRes: THttpResponse<TtransferContinuationResponse>;

        if(transfer.sendCurrency !== this.airtelConfig.X_CURRENCY){
            throw ValidationError.unsupportedCurrencyError();
        }

        if (res.data.currentState === 'WAITING_FOR_CONVERSION_ACCEPTANCE') {
            if (!this.validateConversionTerms(res.data)) {
                if (!res.data.transferId) {
                    throw ValidationError.transferIdNotDefinedError("Transfer Id not defined in transfer response", "4000", 500);
                }

                acceptRes = await this.sdkClient.updateTransfer({
                    "acceptConversion": false
                }, res.data.transferId);
                throw ValidationError.invalidConversionQuoteError("Recieved Conversion Terms are invalid", "4000", 500);
            }
            else {
                if (!res.data.transferId) {
                    throw ValidationError.transferIdNotDefinedError("Transfer Id not defined in transfer response", "4000", 500);
                }
                acceptRes = await this.sdkClient.updateTransfer({
                    "acceptConversion": true
                }, res.data.transferId);
            }

            if (!this.validateReturnedQuote(acceptRes.data)) {
                throw ValidationError.invalidReturnedQuoteError();
            }

            return this.getTAirtelSendMoneyResponse(acceptRes.data);
        }
        if (!this.validateReturnedQuote(res.data)) {
            throw ValidationError.invalidReturnedQuoteError();
        }

        return this.getTAirtelSendMoneyResponse(res.data);

    }

    private async getTSDKOutboundTransferRequest(transfer: TAirtelSendMoneyRequest): Promise<TSDKOutboundTransferRequest> {
        const res = await this.airtelClient.getKyc({
            msisdn: transfer.payerAccount
        });
        return {
            'homeTransactionId': randomUUID(),
            'from': {
                'idType': this.airtelConfig.SUPPORTED_ID_TYPE,
                'idValue': transfer.payerAccount,
                'fspId': this.airtelConfig.FSP_ID,
                "displayName": `${res.data.first_name} ${res.data.last_name}`,
                "firstName": res.data.first_name,
                "middleName": res.data.first_name,
                "lastName": res.data.last_name,
                "merchantClassificationCode": "123",
            },
            'to': {
                'idType': transfer.payeeIdType,
                'idValue': transfer.payeeId
            },
            'amountType': 'SEND',
            'currency': transfer.sendCurrency,
            'amount': transfer.sendAmount,
            'transactionType': transfer.transactionType,
        };
    }

    private getTAirtelSendMoneyResponse(transfer: TSDKOutboundTransferResponse): TAirtelSendMoneyResponse {
        this.logger.info(`Getting response for transfer with Id ${transfer.transferId}`);
        return {
            "payeeDetails": {
                "idType": transfer.to.idType,
                "idValue": transfer.to.idValue,
                "fspId": transfer.to.fspId !== undefined ? transfer.to.fspId : "No FSP ID Returned",
                "displayName": transfer.getPartiesResponse !== undefined ? transfer.getPartiesResponse.body.party.name : "Chikondi Banda",
                "dateOfBirth": transfer.to.dateOfBirth !== undefined ? transfer.to.dateOfBirth : "No Date of Birth Returned",
            },
            "receiveAmount": transfer.quoteResponse?.body.payeeReceiveAmount?.amount !== undefined ? transfer.quoteResponse.body.payeeReceiveAmount.amount : "No payee receive amount",
            "receiveCurrency": transfer.fxQuotesResponse?.body.conversionTerms.targetAmount.currency !== undefined ? transfer.fxQuotesResponse?.body.conversionTerms.targetAmount.currency : "No Currency returned from Mojaloop Connector",
            "fees": transfer.quoteResponse?.body.payeeFspFee?.amount !== undefined ? transfer.quoteResponse?.body.payeeFspFee?.amount : "No fee amount returned from Mojaloop Connector",
            "feeCurrency": transfer.fxQuotesResponse?.body.conversionTerms.targetAmount.currency !== undefined ? transfer.fxQuotesResponse?.body.conversionTerms.targetAmount.currency : "No Fee currency retrned from Mojaloop Connector",
            "transactionId": transfer.transferId !== undefined ? transfer.transferId : "No transferId returned",
        };
    }

    private validateConversionTerms(transferResponse: TSDKOutboundTransferResponse): boolean {
        this.logger.info(`Validating Conversion Terms with transfer response amount ${transferResponse.amount}`);
        let result = true;
        if (
            !(this.airtelConfig.X_CURRENCY === transferResponse.fxQuotesResponse?.body.conversionTerms.sourceAmount.currency)
        ) {
            result = false;
        }
        if (transferResponse.amountType === 'SEND') {
            if (!(transferResponse.amount === transferResponse.fxQuotesResponse?.body.conversionTerms.sourceAmount.amount)) {
                result = false;
            }
            if (!transferResponse.to.supportedCurrencies) {
                throw SDKClientError.genericQuoteValidationError("Payee Supported Currency not defined", { httpCode: 500, mlCode: "4000" });
            }
            if (!transferResponse.to.supportedCurrencies.some(value => value === transferResponse.quoteResponse?.body.transferAmount.currency)) {
                result = false;
            }
            if (!(transferResponse.currency === transferResponse.fxQuotesResponse?.body.conversionTerms.sourceAmount.currency)) {
                result = false;
            }
        } else if (transferResponse.amountType === 'RECEIVE') {
            if (!(transferResponse.amount === transferResponse.fxQuotesResponse?.body.conversionTerms.targetAmount.amount)) {
                result = false;
            }
            if (!(transferResponse.currency === transferResponse.quoteResponse?.body.transferAmount.currency)) {
                result = false;
            }
            if (transferResponse.fxQuotesResponse) {
                if (!transferResponse.from.supportedCurrencies) {
                    throw ValidationError.unsupportedCurrencyError();
                }
                if (!(transferResponse.from.supportedCurrencies.some(value => value === transferResponse.fxQuotesResponse?.body.conversionTerms.targetAmount.currency))) {
                    result = false;
                }
            }
        }
        return result;
    }

    private validateReturnedQuote(transferResponse: TSDKOutboundTransferResponse): boolean {
        this.logger.info(`Validating Retunred Quote with transfer response amount${transferResponse.amount}`);
        let result = true;
        if (!this.validateConversionTerms(transferResponse)) {
            result = false;
        }
        const quoteResponseBody = transferResponse.quoteResponse?.body;
        const fxQuoteResponseBody = transferResponse.fxQuotesResponse?.body;
        if (!quoteResponseBody) {
            throw SDKClientError.noQuoteReturnedError();
        }
        if (transferResponse.amountType === "SEND") {
            if (!(parseFloat(transferResponse.amount) === parseFloat(quoteResponseBody.transferAmount.amount) - parseFloat(quoteResponseBody.payeeFspCommission?.amount || "0"))) {
                result = false;
            }
            if (!quoteResponseBody.payeeReceiveAmount) {
                throw SDKClientError.genericQuoteValidationError("Payee Receive Amount not defined", { httpCode: 500, mlCode: "4000" });
            }
            if (!(parseFloat(quoteResponseBody.payeeReceiveAmount.amount) === parseFloat(quoteResponseBody.transferAmount.amount) - parseFloat(quoteResponseBody.payeeFspCommission?.amount || '0'))) {
                result = false;
            }
            if (!(fxQuoteResponseBody?.conversionTerms.targetAmount.amount === quoteResponseBody.transferAmount.amount)) {
                result = false;
            }
        } else if (transferResponse.amountType === "RECEIVE") {
            if (!transferResponse.quoteResponse) {
                throw SDKClientError.noQuoteReturnedError();
            }
            if (!(parseFloat(transferResponse.amount) === parseFloat(quoteResponseBody.transferAmount.amount) - parseFloat(quoteResponseBody.payeeFspCommission?.amount || "0") + parseFloat(quoteResponseBody.payeeFspFee?.amount || "0"))) {
                result = false;
            }

            if (!(quoteResponseBody.payeeReceiveAmount?.amount === quoteResponseBody.transferAmount.amount)) {
                result = false;
            }
            if (fxQuoteResponseBody) {
                if (!(fxQuoteResponseBody.conversionTerms.targetAmount.amount === quoteResponseBody.transferAmount.amount)) {
                    result = false;
                }
            }
        } else {
            SDKClientError.genericQuoteValidationError("Invalid amountType received", { httpCode: 500, mlCode: "4000" });
        }
        return result;
    }

    async updateSentTransfer(transferAccept: TAirtelUpdateSendMoneyRequest, transferId: string): Promise<TAirtelCollectMoneyResponse> {
        this.logger.info(`Updating transfer for id ${transferAccept.msisdn} and transfer id ${transferId}`);

        if (!(transferAccept.acceptQuote)) {
            throw ValidationError.quoteNotAcceptedError();
        }
        return await this.airtelClient.collectMoney(this.getTAirtelCollectMoneyRequest(transferAccept, transferId));
    }


    private getTAirtelCollectMoneyRequest(collection: TAirtelUpdateSendMoneyRequest, transferId: string): TAirtelCollectMoneyRequest {
        return {
            "reference": "string",
            "subscriber": {
                "country": this.airtelConfig.X_COUNTRY,
                "currency": this.airtelConfig.X_CURRENCY,
                "msisdn": collection.msisdn,
            },
            "transaction": {
                "amount": Number(collection.amount),
                "country": this.airtelConfig.X_COUNTRY,
                "currency": this.airtelConfig.X_CURRENCY,
                "id": transferId,
            }
        };
    }

    async handleCallback(payload: TCallbackRequest): Promise<void> {
        this.logger.info(`Handling callback for transaction with id ${payload.transaction.id}`);
        try {
            if (payload.transaction.status_code === "TS") {
                await this.sdkClient.updateTransfer({ acceptQuote: true }, payload.transaction.id);
            } else {
                await this.sdkClient.updateTransfer({ acceptQuote: false }, payload.transaction.id);
            }
        } catch (error: unknown) {
            if (error instanceof SDKClientError) {
                // perform refund or rollback
                await this.handleRefund(payload);
            }
        }
    }

    private async handleRefund(payload: TCallbackRequest){
        try{
            if(payload.transaction.status_code === "TS"){
                await this.airtelClient.refundMoney({
                    "transaction": {
                        "airtel_money_id": payload.transaction.airtel_money_id,
                    }
                });
            }
        }catch(error: unknown){
            this.logger.error("Refund failed. Initiating manual process...");
            // todo: define a way to start a manual refund process.
            throw error;
        }
    }
}