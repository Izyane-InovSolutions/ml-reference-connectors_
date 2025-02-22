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


 * Niza Tembo <mcwayzj@gmail.com>
 * Elijah Okello <elijahokello90@gmail.com>

 --------------
 ******/

 'use strict';

import config from '../config';

import {
    IMTNClient,
    TMTNConfig,
    TMTNDisbursementRequestBody,
    PartyType,
    TMTNSendMoneyRequest,
    TMTNSendMoneyResponse,
    TMTNCollectMoneyRequest,
    TMTNUpdateSendMoneyRequest,
    TMTNKycResponse,
    TMTNCallbackPayload,
} from './CBSClient';
import {
    ILogger,
    TLookupPartyInfoResponse,
    TQuoteResponse,
    TQuoteRequest,
    TtransferResponse,
    TtransferRequest,
    TtransferPatchNotificationRequest,
    ValidationError,
    THttpResponse,
    TPayeeExtensionListEntry,
    TPayerExtensionListEntry,
} from './interfaces';
import {
    ISDKClient,
    SDKClientError,
    TSDKOutboundTransferRequest,
    TSDKOutboundTransferResponse,
    TtransferContinuationResponse,
} from './SDKClient';

export class CoreConnectorAggregate {
    public IdType: string;
    private logger: ILogger;
    DATE_FORMAT = 'dd MM yy';

    constructor(
        private readonly sdkClient: ISDKClient,
        private readonly mtnClient: IMTNClient,
        private readonly mtnConfig: TMTNConfig,
        logger: ILogger,
    ) {
        // todo: set the IdType from here 
        this.IdType = config.get("mtn.SUPPORTED_ID_TYPE");
        this.logger = logger;
    }

    private async checkAccountBarred(msisdn: string): Promise<void> {
        const res = await this.mtnClient.getKyc({ msisdn: msisdn });
        if (res.status == "NOT FOUND") {
            throw ValidationError.accountBarredError();
        }
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

    //Payee
    async getParties(id: string, idType: string): Promise<TLookupPartyInfoResponse> {
        this.logger.info(`Get Parties for ${id}`);
        if (!(idType === config.get("mtn.SUPPORTED_ID_TYPE"))) {
            throw ValidationError.unsupportedIdTypeError();
        }

        const lookupRes = await this.mtnClient.getKyc({ msisdn: id });
        const party = this.getPartyResponse(lookupRes, id);
        this.logger.info(`Party found`, { party });
        return party;
    }

    private getPartyResponse(mtnKycResponse: TMTNKycResponse, idValue: string): TLookupPartyInfoResponse {
        return {
            data: {
                displayName: `${mtnKycResponse.given_name} ${mtnKycResponse.family_name}`,
                firstName: mtnKycResponse.given_name,
                idType: config.get("mtn.SUPPORTED_ID_TYPE"),
                idValue: idValue,
                lastName: mtnKycResponse.family_name,
                middleName: mtnKycResponse.given_name,
                type: PartyType.CONSUMER,
                kycInformation: `${JSON.stringify(mtnKycResponse)}`,
                extensionList: this.getGetPartiesExtensionList(),
            },
            statusCode: 200,
        };
    }

      // Get Extension List DTO to be used in Party Response on Extension List
    // Get Parties   --(1.1)
    private getGetPartiesExtensionList(): TPayeeExtensionListEntry[] {
        return [
            {
                "key": "Rpt.UpdtdPtyAndAcctId.Agt.FinInstnId.LEI",
                "value": config.get("mtn.LEI")
            },
            {
                "key": "Rpt.UpdtdPtyAndAcctId.Pty.CtryOfRes",
                "value": config.get("mtn.X_COUNTRY")
            }
        ];
    }


    async quoteRequest(quoteRequest: TQuoteRequest): Promise<TQuoteResponse> {
        this.logger.info(`Quote requests for ${this.IdType} ${quoteRequest.to.idValue}`);
        if (quoteRequest.to.idType !== this.IdType) {
            throw ValidationError.unsupportedIdTypeError();
        }
        if (this.mtnConfig.MTN_ENV === 'production' && quoteRequest.currency !== config.get("mtn.X_CURRENCY")) {
            throw ValidationError.unsupportedCurrencyError();
        }

        if (!this.checkQuoteExtensionLists(quoteRequest)) {
            throw ValidationError.invalidExtensionListsError(
                "Some extensionLists are undefined",
                '3100',
                500
            );
        }

        const serviceChargePercentage = Number(config.get("mtn.SERVICE_CHARGE"));
        const fees = serviceChargePercentage / 100 * Number(quoteRequest.amount);
        await this.checkAccountBarred(quoteRequest.to.idValue);
        const quoteExpiration = config.get("mtn.EXPIRATION_DURATION");
        const expiration = new Date();
        expiration.setHours(expiration.getHours() + Number(quoteExpiration));
        const expirationJSON = expiration.toJSON();
        return this.getQuoteResponse(quoteRequest, fees.toString(), expirationJSON);
    }


    private getQuoteResponse(quoteRequest: TQuoteRequest, fees: string, expiration: string): TQuoteResponse {
        return {
            expiration: expiration,
            extensionList: this.getQuoteResponseExtensionList(quoteRequest),
            payeeFspCommissionAmount: '0',
            payeeFspCommissionAmountCurrency: quoteRequest.currency,
            payeeFspFeeAmount: fees,
            payeeFspFeeAmountCurrency: quoteRequest.currency,
            payeeReceiveAmount: quoteRequest.amount,
            payeeReceiveAmountCurrency: quoteRequest.currency,
            quoteId: quoteRequest.quoteId,
            transactionId: quoteRequest.transactionId,
            transferAmount: (Number(quoteRequest.amount) + Number(fees)).toString(),
            transferAmountCurrency: quoteRequest.currency,
        };
    }


    private checkQuoteExtensionLists(quoteRequest: TQuoteRequest): boolean {
        return !!(quoteRequest.to.extensionList && quoteRequest.from.extensionList && quoteRequest.to.extensionList.length > 0 && quoteRequest.from.extensionList.length > 0);
    }


    // Get Quote Resonse Extension List DTO to be used in Quote Response on Extension List
   
    private getQuoteResponseExtensionList(quoteRequest: TQuoteRequest): TPayeeExtensionListEntry[] {
        const newExtensionList: TPayeeExtensionListEntry[] = [];
        //todo: check if the correct level of information has been provided.
        if (quoteRequest.extensionList) {
            newExtensionList.push(...quoteRequest.extensionList);
        }

        if (quoteRequest.from.extensionList) {
            newExtensionList.push(...quoteRequest.from.extensionList);
        }

        if (quoteRequest.to.extensionList) {
            newExtensionList.push(...quoteRequest.to.extensionList);
        }
        return newExtensionList;
    }


    async receiveTransfer(transfer: TtransferRequest): Promise<TtransferResponse> {
        this.logger.info(`Transfer for  ${this.IdType} ${transfer.to.idValue}`);
        if (transfer.to.idType != this.IdType) {
            throw ValidationError.unsupportedIdTypeError();
        }
        if (this.mtnConfig.MTN_ENV === 'production' && transfer.currency !== config.get("mtn.X_CURRENCY")) {
            throw ValidationError.unsupportedCurrencyError();
        }

        if (!this.checkPayeeTransfersExtensionLists(transfer)) {
            throw ValidationError.invalidExtensionListsError(
                "ExtensionList check Failed in Payee Transfers",
                '3100',
                500
            );
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


    private checkPayeeTransfersExtensionLists(transfer: TtransferRequest): boolean {
        this.logger.info(`checking Payee Transfer Extension List ${transfer}`);
        return !!(transfer.to.extensionList && transfer.from.extensionList && transfer.to.extensionList.length > 0 && transfer.from.extensionList.length > 0);
    }


    async updateTransfer(updateTransferPayload: TtransferPatchNotificationRequest, transferId: string): Promise<void> {
        this.logger.info(`Committing The Transfer with id ${transferId}`);
        if (updateTransferPayload.currentState !== 'COMPLETED') {
            throw ValidationError.transferNotCompletedError();
        }
        const mtnDisbursementRequest: TMTNDisbursementRequestBody = this.getDisbursementRequestBody(updateTransferPayload);
        try {
            await this.mtnClient.sendMoney(mtnDisbursementRequest);
        } catch (error: unknown) {
            await this.performRefundTransfer();
        }
    }

    async performRefundTransfer() {
        //todo: to be implemented
    }


    private getDisbursementRequestBody(requestBody: TtransferPatchNotificationRequest): TMTNDisbursementRequestBody {
        if (!requestBody.quoteRequest) {
            throw ValidationError.quoteNotDefinedError('Quote Not Defined Error', '5000', 500);
        }
        if (!requestBody.transferId) {
            throw ValidationError.transferIdNotDefinedError("TransferId Not Defined", '5000', 500);
        }
        return {
            "amount": requestBody.quoteRequest.body.amount.amount,
            "currency": this.mtnConfig.X_CURRENCY,
            "externalId" : requestBody.transferId,
            "payee": {
            "partyIdType": requestBody.quoteRequest.body.payee.partyIdInfo.partyIdType,
             "partyId": requestBody.quoteRequest.body.payee.partyIdInfo.partyIdentifier
            },
            "payerMessage": "Payer Attached Note For Transactions",
            "payeeNote" : "Sending Money"
 
         };
 
     }
 
     private getTMTNSendMoneyResponse(transfer: TSDKOutboundTransferResponse): TMTNSendMoneyResponse {
         this.logger.info(`Getting response for transfer with Id ${transfer.transferId}`);
         return {
             "payeeDetails": {
                 "idType": transfer.to.idType,
                 "idValue":transfer.to.idValue,
                 "fspId": transfer.to.fspId !== undefined ? transfer.to.fspId : "No FSP ID Returned",
                 "firstName": transfer.to.firstName !== undefined ? transfer.to.firstName : "No First Name Returned",
                 "lastName":transfer.to.lastName !== undefined ? transfer.to.lastName : "No Last Name Returned",
                 "dateOfBirth":transfer.to.dateOfBirth !== undefined ? transfer.to.dateOfBirth : "No Date of Birth Returned",
             },
             "receiveAmount": transfer.quoteResponse?.body.payeeReceiveAmount?.amount !== undefined ? transfer.quoteResponse.body.payeeReceiveAmount.amount : "No payee receive amount",
             "receiveCurrency": transfer.fxQuotesResponse?.body.conversionTerms.targetAmount.currency !== undefined ? transfer.fxQuotesResponse?.body.conversionTerms.targetAmount.currency : "No Currency returned from Mojaloop Connector" ,
             "fees": transfer.quoteResponse?.body.payeeFspFee?.amount !== undefined ? transfer.quoteResponse?.body.payeeFspFee?.amount : "No fee amount returned from Mojaloop Connector",
             "feeCurrency": transfer.fxQuotesResponse?.body.conversionTerms.targetAmount.currency !== undefined ? transfer.fxQuotesResponse?.body.conversionTerms.targetAmount.currency : "No Fee currency retrned from Mojaloop Connector",
             "transactionId": transfer.transferId !== undefined ? transfer.transferId : "No transferId returned",
         };
     }
 
    private validateConversionTerms(transferResponse: TSDKOutboundTransferResponse): boolean {
        this.logger.info(`Validating Conversion Terms with transfer response amount ${transferResponse.amount}`);
        let result = true;
        if (
            this.mtnConfig.MTN_ENV === 'production' && !(this.mtnConfig.X_CURRENCY === transferResponse.fxQuotesResponse?.body.conversionTerms.sourceAmount.currency)
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

 
 
     private async getTSDKOutboundTransferRequest(transfer: TMTNSendMoneyRequest, amountType: "SEND" | "RECEIVE"): Promise<TSDKOutboundTransferRequest> {
         const res = await this.mtnClient.getKyc({
             msisdn: transfer.payer.payerId
         });
         return {
             'homeTransactionId': transfer.homeTransactionId,
             'from': {
                 'idType': this.mtnConfig.SUPPORTED_ID_TYPE,
                 'idValue': transfer.payer.payerId,
                 'fspId': this.mtnConfig.FSP_ID,
                 "displayName": `${res.given_name} ${res.family_name}`,
                 "firstName": res.given_name,
                 "middleName": res.given_name,
                 "lastName": res.family_name,
                 "merchantClassificationCode": "123",
                 "extensionList": this.getOutboundTransferExtensionList(transfer)
             },
             'to': {
                 'idType': transfer.payeeIdType,
                 'idValue': transfer.payeeId
             },
             'amountType': amountType,
             'currency': transfer.sendCurrency,
             'amount': transfer.sendAmount,
             'transactionType': transfer.transactionType,
         };
     }

     // Get OutBound Transfer Extension List DTO used in getTSDKOutboundTransferRequest DTO --(5.1.1)
    private getOutboundTransferExtensionList(sendMoneyRequestPayload: TMTNSendMoneyRequest): TPayerExtensionListEntry[] {
        return [
            {
                "key": "CdtTrfTxInf.Dbtr.PrvtId.DtAndPlcOfBirth.BirthDt",
                "value": sendMoneyRequestPayload.payer.DateAndPlaceOfBirth.BirthDt
            },
            {
                "key": "CdtTrfTxInf.Dbtr.PrvtId.DtAndPlcOfBirth.PrvcOfBirth",
                "value": sendMoneyRequestPayload.payer.DateAndPlaceOfBirth.PrvcOfBirth
            },
            {
                "key": "CdtTrfTxInf.Dbtr.PrvtId.DtAndPlcOfBirth.CityOfBirth",
                "value": sendMoneyRequestPayload.payer.DateAndPlaceOfBirth.CityOfBirth
            },
            {
                "key": "CdtTrfTxInf.Dbtr.PrvtId.DtAndPlcOfBirth.CtryOfBirth",
                "value": sendMoneyRequestPayload.payer.DateAndPlaceOfBirth.CtryOfBirth
            }
        ];
    }
    
     
     // Payer
     async sendTransfer(transfer: TMTNSendMoneyRequest, amountType: "SEND" | "RECEIVE"): Promise<TMTNSendMoneyResponse> {
         this.logger.info(`Transfer from mtn account with ID ${transfer.payer.payerId}`);
 
         const transferRequest: TSDKOutboundTransferRequest = await this.getTSDKOutboundTransferRequest(transfer, amountType);
         const res = await this.sdkClient.initiateTransfer(transferRequest);
         let acceptRes: THttpResponse<TtransferContinuationResponse>;
 
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
             return this.getTMTNSendMoneyResponse(acceptRes.data);
         }
         if (!this.validateReturnedQuote(res.data)) {
             throw ValidationError.invalidReturnedQuoteError();
         }
         return this.getTMTNSendMoneyResponse(res.data);
     }
 

    
 
     private getTMTNCollectMoneyRequest(deps: TMTNUpdateSendMoneyRequest, transferId: string): TMTNCollectMoneyRequest {
         return {
             "amount": deps.amount,
             "amountType": "RECEIVE",
             "currency": this.mtnConfig.X_CURRENCY,
             "externalId": transferId,
             "payer" :{
                 "partyId": deps.msisdn,
                 "partyIdType": this.mtnConfig.SUPPORTED_ID_TYPE,
             },
             "payerMessage": deps.payerMessage,
             "payeeNote": deps.payeeNote,
             
         };
     }
 
 
 
     async updateSentTransfer(transferAccept: TMTNUpdateSendMoneyRequest, transferId: string): Promise<void> {
         this.logger.info(`Updating transfer for id ${transferAccept.msisdn} and transfer id ${transferId}`);
 
         if (!(transferAccept.acceptQuote)) {
             throw ValidationError.quoteNotAcceptedError();
         }
         await this.mtnClient.collectMoney(this.getTMTNCollectMoneyRequest(transferAccept, transferId));
     }
 
     async handleCallback(payload: TMTNCallbackPayload): Promise<void>{
         this.logger.info(`Handling callback for transaction with id ${payload.externalId}`);
         if(payload.status === "SUCCESSFUL"){
             await this.sdkClient.updateTransfer({acceptQuote: true},payload.externalId);
         }else{
             await this.sdkClient.updateTransfer({acceptQuote: false},payload.externalId);
         }
     }
     
 }
 
 
 