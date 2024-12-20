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

 --------------
 ******/

'use strict';

import { randomUUID } from 'node:crypto';
import config from '../config';
import {
    ITNMClient,
    PartyType,
    TMakePaymentRequest,
    TNMCallbackPayload,
    TNMConfig,
    TNMError,
    TNMInvoiceRequest,
    TNMInvoiceResponse,
    TNMSendMoneyRequest,
    TNMSendMoneyResponse,
    TNMUpdateSendMoneyRequest,
} from './CBSClient';
import {
    ILogger,
    TLookupPartyInfoResponse,
    TQuoteResponse,
    TQuoteRequest,
    TtransferResponse,
    TtransferRequest,
    ICoreConnectorAggregate,
    TtransferPatchNotificationRequest,
    ValidationError,
    THttpResponse,
} from './interfaces';
import {
    ISDKClient,
    SDKClientError,
    TSDKOutboundTransferRequest,
    TSDKOutboundTransferResponse,
    TtransferContinuationResponse,
} from './SDKClient';

export class CoreConnectorAggregate implements ICoreConnectorAggregate {
    IdType: string;
    logger: ILogger;
    DATE_FORMAT = 'dd MM yy';

    constructor(
        readonly sdkClient: ISDKClient,
        readonly tnmClient: ITNMClient,
        readonly tnmConfig: TNMConfig,
        logger: ILogger,
    ) {
        // todo: set the IdType from here
        this.IdType = "MSISDN";
        this.logger = logger;
    }

    //Payee
    async getParties(id: string, idType: string): Promise<TLookupPartyInfoResponse> {
        this.logger.info(`Get Parties for ${id}`);
        if (!(idType === this.tnmClient.tnmConfig.SUPPORTED_ID_TYPE)) {
            throw ValidationError.unsupportedIdTypeError();
        }

        const lookupRes = await this.tnmClient.getKyc({ msisdn: id });
        const party = {
            data: {
                displayName: `${lookupRes.data.full_name}`,
                firstName: lookupRes.data.full_name,
                idType: this.tnmClient.tnmConfig.SUPPORTED_ID_TYPE,
                idValue: id,
                lastName: lookupRes.data.full_name,
                middleName: lookupRes.data.full_name,
                type: PartyType.CONSUMER,
                kycInformation: `${JSON.stringify(lookupRes)}`,
            },
            statusCode: 200,
        };
        this.logger.info(`Party found`, { party });
        return party;
    }

    async quoteRequest(quoteRequest: TQuoteRequest): Promise<TQuoteResponse> {
        this.logger.info(`Quote requests for ${this.IdType} ${quoteRequest.to.idValue}`);
        if (quoteRequest.to.idType !== this.IdType) {
            throw ValidationError.unsupportedIdTypeError();
        }

        if (quoteRequest.currency !== config.get("tnm.TNM_CURRENCY")) {
            throw ValidationError.unsupportedCurrencyError();
        }

        const res = await this.tnmClient.getKyc({
            msisdn: quoteRequest.to.idValue,

        });
        //TODO: Implement bar checking
        if (res.message != "Completed successfully") {
            throw TNMError.payeeBlockedError("Account is barred ", 500, "5400");
        }

        const serviceChargePercentage = Number(config.get("tnm.SENDING_SERVICE_CHARGE"));
        const fees = serviceChargePercentage / 100 * Number(quoteRequest.amount);

        await this.checkAccountBarred(quoteRequest.to.idValue);

        const quoteExpiration = config.get("tnm.EXPIRATION_DURATION");
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
            transferAmount: (Number(quoteRequest.amount) + fees).toString() ,
            transferAmountCurrency: quoteRequest.currency,
        };
    }

    //TODO: Check actual response for barred accounts
    private async checkAccountBarred(msisdn: string): Promise<void> {
        const res = await this.tnmClient.getKyc({ msisdn: msisdn });
        if (res.message != "Completed successfully") {
            throw ValidationError.accountBarredError();
        }
    }

    async receiveTransfer(transfer: TtransferRequest): Promise<TtransferResponse> {
        this.logger.info(`Received transfer request for ${transfer.to.idValue}`);
        if (transfer.to.idType != this.IdType) {
            throw ValidationError.unsupportedIdTypeError();
        }

        if (transfer.currency !== config.get("tnm.TNM_CURRENCY")) {
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
        // todo define implmentation
        this.logger.info(`Validating code for transfer with amount ${transfer.amount}`);
        return true;
    }

    async updateTransfer(updateTransferPayload: TtransferPatchNotificationRequest, transferId: string): Promise<void> {
        this.logger.info(`Committing transfer on patch notification for ${updateTransferPayload.quoteRequest?.body.payee.partyIdInfo.partyIdentifier} and transfer id ${transferId}`);
        if (updateTransferPayload.currentState !== 'COMPLETED') {
            throw ValidationError.transferNotCompletedError();
        }
        if (!this.validatePatchQuote(updateTransferPayload)) {
            throw ValidationError.invalidQuoteError();
        }

        const makePaymentRequest: TMakePaymentRequest = this.getMakePaymentRequestBody(updateTransferPayload);
        await this.tnmClient.sendMoney(makePaymentRequest);

    }


    private getMakePaymentRequestBody(requestBody: TtransferPatchNotificationRequest): TMakePaymentRequest {
        if (!requestBody.quoteRequest) {
            throw ValidationError.quoteNotDefinedError('Quote Not Defined Error', '5000', 500);
        }

        return {
            "msisdn": requestBody.quoteRequest.body.payee.partyIdInfo.partyIdentifier,
            "amount": requestBody.quoteRequest.body.amount.amount,
            "transaction_id": requestBody.quoteRequest.body.transactionId,
            "narration": requestBody.quoteRequest.body.note !== undefined ? requestBody.quoteRequest.body.note : "No note returned"
        };
    }


    private validatePatchQuote(transfer: TtransferPatchNotificationRequest): boolean {
        this.logger.info(`Validating code for transfer with state ${transfer.currentState}`);
        // todo define implmentation
        return true;
    }


    // Payer
    async sendMoney(transfer: TNMSendMoneyRequest): Promise<TNMSendMoneyResponse> {
        this.logger.info(`Received send money request for payer with ID ${transfer.payerAccount}`);
        const res = await this.sdkClient.initiateTransfer(await this.getTSDKOutboundTransferRequest(transfer));
        if (res.data.currentState === "WAITING_FOR_CONVERSION_ACCEPTANCE") {
            return await this.checkAndRespondToConversionTerms(res);
        }
        if (!this.validateReturnedQuote(res.data)) {
            throw ValidationError.invalidReturnedQuoteError();
        }
        return this.getTCbsSendMoneyResponse(res.data);
    }

    private async checkAndRespondToConversionTerms(res: THttpResponse<TSDKOutboundTransferResponse>): Promise<TNMSendMoneyResponse> {
        let acceptRes: THttpResponse<TtransferContinuationResponse>;
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
        return this.getTCbsSendMoneyResponse(acceptRes.data);
    }

    private validateConversionTerms(transferResponse: TSDKOutboundTransferResponse): boolean {
        this.logger.info(`Validating Conversion Terms with transfer response amount${transferResponse.amount}`);
        // todo: Define Implementations
        return true;
    }

    private validateReturnedQuote(transferResponse: TSDKOutboundTransferResponse): boolean {
        this.logger.info(`Validating Retunred Quote with transfer response amount${transferResponse.amount}`);
        // todo: Define Implementations
        return true;
    }

    private getTCbsSendMoneyResponse(transfer: TSDKOutboundTransferResponse): TNMSendMoneyResponse {
        this.logger.info(`Getting response for transfer with Id ${transfer.transferId}`);
        return {
            "payeeDetails": {
                "idType": transfer.to.idType,
                "idValue": transfer.to.idValue,
                "fspId": transfer.to.fspId !== undefined ? transfer.to.fspId : "No FSP ID Returned",
                "firstName": transfer.to.firstName !== undefined ? transfer.to.firstName : "No First Name Returned",
                "lastName": transfer.to.lastName !== undefined ? transfer.to.lastName : "No Last Name Returned",
                "dateOfBirth": transfer.to.dateOfBirth !== undefined ? transfer.to.dateOfBirth : "No Date of Birth Returned",
            },
            "receiveAmount": transfer.quoteResponse?.body.payeeReceiveAmount?.amount !== undefined ? transfer.quoteResponse.body.payeeReceiveAmount.amount : "No payee receive amount",
            "receiveCurrency": transfer.fxQuotesResponse?.body.conversionTerms.targetAmount.currency !== undefined ? transfer.fxQuotesResponse?.body.conversionTerms.targetAmount.currency : "No Currency returned from Mojaloop Connector",
            "fees": transfer.quoteResponse?.body.payeeFspFee?.amount !== undefined ? transfer.quoteResponse?.body.payeeFspFee?.amount : "No fee amount returned from Mojaloop Connector",
            "feeCurrency": transfer.fxQuotesResponse?.body.conversionTerms.targetAmount.currency !== undefined ? transfer.fxQuotesResponse?.body.conversionTerms.targetAmount.currency : "No Fee currency retrned from Mojaloop Connector",
            "transactionId": transfer.transferId !== undefined ? transfer.transferId : "No transferId returned",
        };
    }

    private async getTSDKOutboundTransferRequest(transfer: TNMSendMoneyRequest): Promise<TSDKOutboundTransferRequest> {
        const res = await this.tnmClient.getKyc({
            msisdn: transfer.payerAccount
        });
        return {
            'homeTransactionId': randomUUID(),
            'from': {
                'idType': this.tnmConfig.SUPPORTED_ID_TYPE,
                'idValue': transfer.payerAccount,
                'fspId': this.tnmConfig.FSP_ID,
                "displayName": res.data.full_name,
                "firstName": res.data.full_name,
                "middleName": res.data.full_name,
                "lastName": res.data.full_name,
                "merchantClassificationCode": "123", //todo: clarify what is needed here
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

    async updateSendMoney(updateSendMoneyDeps: TNMUpdateSendMoneyRequest, transferId: string): Promise<TNMInvoiceResponse> {
        this.logger.info(`Updating transfer for id ${updateSendMoneyDeps.msisdn} and transfer id ${transferId}`);

        if (!(updateSendMoneyDeps.acceptQuote)) {
            throw ValidationError.quoteNotAcceptedError();
        }
        return await this.tnmClient.collectMoney(this.getTCbsCollectMoneyRequest(updateSendMoneyDeps, transferId));
    }

    private getTCbsCollectMoneyRequest(collection: TNMUpdateSendMoneyRequest, transferId: string): TNMInvoiceRequest {
        return {
            invoice_number: transferId,
            amount: Number(collection.amount),
            msisdn: collection.msisdn,
            description: collection.narration,
        };
    }

    async handleCallback(payload: TNMCallbackPayload): Promise<void> {
        this.logger.info(`Handling callback for transaction with id ${payload.transaction_id}`);
        try{
            if(payload.success){
                await this.sdkClient.updateTransfer({acceptQuote: true},payload.transaction_id);
            }else{
                await this.sdkClient.updateTransfer({acceptQuote: false},payload.transaction_id);
            }
        }catch (error: unknown){
            if(error instanceof SDKClientError){
                // perform refund or rollback
                await this.handleRefund(payload);
            }
        }
    }

    private async handleRefund(payload: TNMCallbackPayload){
        try{
            if(payload.success){
                await this.tnmClient.refundPayment({receipt_number:payload.receipt_number});
            }
        }catch(error: unknown){
            this.logger.error("Refund failed. Initiating manual process...");
            // todo: define a way to start a manual refund process.
            throw error;
        }
    }
}
