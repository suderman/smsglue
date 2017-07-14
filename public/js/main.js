jQuery(function($){

  // var tooltip, // global variables oh my! Refactor when deploying!
  //   hidetooltiptimer
  //
  // function createtooltip(){ // call this function ONCE at the end of page to create tool tip object
  //   tooltip = document.createElement('div')
  //   tooltip.style.cssText = 
  //     'position:absolute; background:black; color:white; padding:4px;z-index:10000;'
  //     + 'border-radius:2px; font-size:12px;box-shadow:3px 3px 3px rgba(0,0,0,.4);'
  //     + 'opacity:0;transition:opacity 0.3s'
  //   tooltip.innerHTML = 'Copied!'
  //   document.body.appendChild(tooltip)
  // }
  //
  // function showtooltip(e){
  //   var evt = e || event
  //   clearTimeout(hidetooltiptimer)
  //   tooltip.style.left = evt.pageX - 10 + 'px'
  //   tooltip.style.top = evt.pageY + 15 + 'px'
  //   tooltip.style.opacity = 1
  //   hidetooltiptimer = setTimeout(function(){
  //     tooltip.style.opacity = 0
  //   }, 500)
  // }
  //
  // function selectElementText(el){
  //   var range = document.createRange() // create new range object
  //   range.selectNodeContents(el) // set range to encompass desired element text
  //   var selection = window.getSelection() // get Selection object from currently user selected text
  //   selection.removeAllRanges() // unselect any user selected text (if any)
  //   selection.addRange(range) // add range to Selection object to select it
  // }  
  //
  // function copySelectionText(){
  //   var copysuccess // var to check whether execCommand successfully executed
  //   try{
  //     copysuccess = document.execCommand("copy") // run command to copy selected text to clipboard
  //   } catch(e){
  //     copysuccess = false
  //   }
  //   return copysuccess
  // }
  
  var isMobile = (/Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Windows Phone/i.test(navigator.userAgent)) ? true : false;
  

  $('form[name=enable]').submit(function(e) {
    e.preventDefault();

    $.post($(this).attr('action'), {

        user: $('input[name=user]').val(),
        pass: $('input[name=pass]').val(),
        did: $('input[name=did]').val(),
        action: 'enable'

    }).done(function(data) {
      if (data.response.error==0) {
        console.log(data.response.hooks);
        // $('input[name=provision_url]').val(data.response.hooks.provision.url)
        // $('input[name=send_url]').val(data.response.hooks.send.url)
        // $('input[name=send_post]').val(data.response.hooks.send.post)
        // $('input[name=fetch_url]').val(data.response.hooks.fetch.url)
        // $('input[name=fetch_post]').val(data.response.hooks.fetch.post)

        $('.not-ready').removeClass('not-ready').addClass('ready');

        $('div.provision_url').text(data.response.hooks.provision.url)
        $('div.send_url').text(data.response.hooks.send.url)
        $('div.send_post').text(data.response.hooks.send.post)
        $('div.fetch_url').text(data.response.hooks.fetch.url)
        $('div.fetch_post').text(data.response.hooks.fetch.post)
      }
    });

  });


  $('input.copy').click(function(e) {
    $(this).focus().select();
  })

  $('.field-to-copy div, .field-to-copy button').on('click', function(){
    var $div = $(this).closest('.field-to-copy').find('div'),
        $button = $(this).closest('.field-to-copy').find('button');

    var range = document.createRange();
    range.selectNodeContents($div.get(0))

    var selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);

    try{
      document.execCommand("copy") // run command to copy selected text to clipboard

      var buttonText = $button.text();
      $button.text('Copied to clipboard!');
      window.setTimeout(function(){
        $button.text(buttonText);
      }, 2000);

      // if (isMobile) {
      //   window.alert('Copied to clipboard! Opening Acrobits Softphone or Groundwire');
      //   window.location.href = 'sip://';
      // }
    } catch(e){
      $button.css({background: 'red'});
    }
  });

});
