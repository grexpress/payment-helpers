function renderXPaypalButtons($ = jQuery) {
    let paramsJson = '{"' + decodeURI(window.location.search.slice(1).replace(/&/g, "\",\"").replace(/=/g, "\":\"")) + '"}'
    let urlParams = paramsJson == '{""}' ? {} : JSON.parse(paramsJson)

    XPayPalGateway = {
        debug: true,//urlParams['debug'] == "true",
        error: {
            generic: 'We cannot process your payment now, please try again with another method.'
        }
    }

    function toggle(time = 5000) {
        if(XPayPalGateway.debug) {
            return new Promise((resolve) => {
                setTimeout(() => resolve(), time)
            })
        } else {
            return new Promise(resolve => resolve())
        }
    }

    function toggleLoader(visible, data = {}, message = "") {
        if(!visible || data.paymentSource != 'paypal') {
            $('#xpaypal-full-screen-loader').css('display', visible ? 'flex' : 'none')
            $('#xpaypal-full-screen-message').text(message)
        }
        return toggle()
    }

    function toggleFullScreenLoader(visible, data) {
        if(!visible || data.paymentSource != 'paypal') {
            return sendMessageToParentWindow('gr-onPaypalMessageVisibility', { data: { visible, ...data }})
        } else {
            return toggle()
        }
    }

    function renderButtons() {
        let orderData = {}
        let wooCheckoutFormInfo = {}
        
        paypal.Buttons({
            onInit: function (data, actions) { },
            onClick: function (data, actions) {
                XPayPalGateway.debug && console.log('onClick', data)
                return sendMessageToParentWindow('gr-onPaypalButtonClick', { data })
                    .then(result => {
                        XPayPalGateway.debug && console.log('onClick Data', result)
                        wooCheckoutFormInfo = result
                        return result
                    })
                    .catch(e => {
                        return actions.reject()
                    })
            },
            createOrder: function (data, actions) {
                XPayPalGateway.debug && console.log('createOrder', data, wooCheckoutFormInfo)
                let { shipping, purchase_units, intent = 'capture', billing } = wooCheckoutFormInfo || {}
                purchase_units = purchase_units.map(unit => ({
                    ...unit,
                    shipping: !shipping.country ? undefined : {
                        address: {
                            country_code: shipping.country,
                            address_line_1: shipping.address_1,
                            address_line_2: shipping.address_2,
                            postal_code: shipping.postcode,
                            admin_area_1: shipping.state || "",
                            admin_area_2: shipping.city || ""
                        },
                        name: {
                            full_name: `${shipping.first_name || ''} ${shipping.last_name || ''}`.trim()
                        }
                    }
                }))
                const application_context = {
                    brand_name: "merchant",
                    user_action: "CONTINUE",
                    shipping_preference: "NO_SHIPPING", // "SET_PROVIDED_ADDRESS",
                }
                const payer = !billing.email || !billing.country ? undefined : {
                    email_address: billing.email,
                    phone: !billing.phone ? undefined : {
                        phone_type: "MOBILE",
                        phone_number: {
                            national_number: billing.phone ? billing.phone.replace(/[^0-9]+/g, '') : ""
                        }, 
                    },
                    address: {
                        country_code: billing.country,
                        address_line_1: billing.address_1,
                        address_line_2: billing.address_2,
                        postal_code: billing.postcode,
                        admin_area_1: billing.state || "",
                        admin_area_2: billing.city || "",
                    },
                    name : {
                        given_name: billing.first_name,
                        surname: billing.last_name
                    },
                }

                orderData = {
                    intent,
                    payer,
                    purchase_units,
                    application_context
                };
                
                return toggleLoader(true, data).then(() => actions.order.create(orderData)).finally(() => { toggleLoader(false) });
            },
            onApprove: function (data, actions) {
                XPayPalGateway.debug && console.log('onApprove', data)
                const paypalOrderId = data.orderID || data.id;
                const signature = wooCheckoutFormInfo.signature
                let createdOrder = {}
                return toggleFullScreenLoader(true, data)
                    .then(() => sendMessageToParentWindow('gr-onPaypalOrderCreated', { data: { orderID: paypalOrderId, signature } }))
                    .then((result) => {
                        createdOrder = result
                        if(result.order_id) {
                            return actions.order.capture()
                        } else {
                            throw new Error('Create order failed')
                        }
                    })
                    .then((capturedOrder) => sendMessageToParentWindow('gr-onPaypalOrderCompleted', { data: { ...capturedOrder, order_id: createdOrder.order_id, signature } }))
                    .finally(() => { toggleFullScreenLoader(false) });
            },
            onCancel: function (data) {
                try {
                    postMessageToParentWindow('gr-onPaypalOrderCancel', { data });
                } finally {
                    toggleFullScreenLoader(false, data)
                }
            },
            onError: function (error) {
                try {
                    XPayPalGateway.debug && console.log('On Paypal Error', error)
                    let errMsg = null

                    let errorText = typeof error == 'string' ? error : error.message
                    if (errorText) {
                        try {
                            let jsonErrorText = errorText.match(/{(.*)}$/gm)
                            let jsonError = JSON.parse(jsonErrorText)

                            if(jsonError && jsonError.type == 'gr-event' && jsonError.handled) {
                                return
                            }
                            if (jsonError && jsonError.name && jsonError.message) {
                                errMsg = `[${jsonError.name}] ${jsonError.message}`
                            }
                        } catch (error) {
                           console.error('Unknown error: ', error)
                        }
                    }

                    if(!errMsg || (errMsg && !errMsg.includes('popup close'))) {
                        postMessageToParentWindow('gr-onPaypalOrderError', { error: errMsg || XPayPalGateway.error.generic });
                    }
                } finally {
                    toggleFullScreenLoader(false)
                }
                
            }
        }).render('#paypal-button-container');
    }

    function registerObserver() {
        jQuery(document).ready(() => {
            new MutationObserver(function (mutations) {
                mutations.find(mutation => {
                    if (mutation.addedNodes.length) {
                        let node = [...mutation.addedNodes].find(node => node.id.startsWith("paypal-overlay-uid"))
                        node && handleOverlayShow(node)
                    }

                    if (mutation.removedNodes.length) {
                        let node = [...mutation.removedNodes].find(node => node.id.startsWith("paypal-overlay-uid"))
                        node && handleOverlayHide(node)
                    }
                })
            }).observe(document, { attributes: true, childList: true, characterData: false, subtree: true });

            const resizeElement = document.getElementById('paypal-button-container');
            new ResizeObserver((entries) => {
                for (const entry of entries) {
                    postMessageToParentWindow('gr-onPaypalResize', { data: { height: entry.target.clientHeight } })
                }
            }).observe(resizeElement);
        })
    }

    if (!window.ResizeObserver) {
        loadjs("https://unpkg.com/browse/resize-observer-polyfill@1.0.0/dist/ResizeObserver.js", function () {
            registerObserver()
        });
    } else {
        registerObserver()
    }

    function handleOverlayShow() {
        let iframe = document.querySelector('iframe[name*="_paypal-overlay-uid_"]')
        if (iframe && iframe.contentDocument) {
            jQuery(iframe).css('border', 'none')
            jQuery('#paypal-button-container').css('display', 'none')
            postMessageToParentWindow("gr-onPaypalShowOverlay")
        }
    }

    function handleOverlayHide() {
        sendMessageToParentWindow("gr-onPaypalHideOverlay").finally(() => {
            jQuery('#paypal-button-container').css('display', '')
        })
    }

    function postMessageToParentWindow(key, { data, error } = {}) {
        //XPayPalGateway.debug && console.log(`Post message ${key} data=${JSON.stringify(data)} error=${error}`)
        let postData = { type: 'gr-event', key, data, error }
        window.parent.postMessage(postData, "*");
    }

    function sendMessageToParentWindow(key, { data, error } = {}) {
        //XPayPalGateway.debug && console.log(`Send message ${key} data=${JSON.stringify(data)} error=${error}`)

        return new Promise((res, rej) => {
            let timeoutSchedule
            const channel = new MessageChannel();
            channel.port1.onmessage = ({ data }) => {
                //XPayPalGateway.debug && console.log(`on message ${JSON.stringify(data)}`)

                channel.port1.close();
                timeoutSchedule && clearTimeout(timeoutSchedule)

                if (data.error || !data.data) {
                    rej(data.error || 'Unknown error');
                } else {
                    res(data.data);
                }
            };
            channel.port1.onmessageerror = (e) => {
                //XPayPalGateway.debug && console.log(`on error ${JSON.stringify(data)}`)
                channel.port1.close();
                timeoutSchedule && clearTimeout(timeoutSchedule)
            }

            timeoutSchedule = setTimeout(() => {
                channel.port1.close();
                rej('Timeout');
            }, 30000)

            window.parent.postMessage({ type: 'gr-event', key, data, error }, "*", [channel.port2]);
        });
    }

    let paypalParams = {
        "client-id": urlParams['client-id'],
        "vault": urlParams['vault'] || 'true',
        "commit": urlParams['commit'] || 'false',
        "components": urlParams['components'],
        "intent": urlParams['intent'] || 'capture',
        "enable-funding": urlParams['enable-funding'],
    }

    let query = Object.entries(paypalParams)
        .filter(entry => entry[1] != undefined)
        .map(([key, value]) => `${key}=${value}`).join('&')
    let paypalUrl = 'https://www.paypal.com/sdk/js?' + query
    
    loadjs(paypalUrl, function () {
        renderButtons()
        postMessageToParentWindow('gr-onPaypalResize', { data: { height: jQuery('#paypal-button-container').height() } })
    });

    // window.paypalLoadScript(paypalParams).then((paypal) => {
    //   renderButtons()
    //   postMessageToParentWindow('gr-onPaypalResize', { data: { height: jQuery('#paypal-button-container').height() } })
    // });
}

jQuery(document).ready(() => renderXPaypalButtons(jQuery))
