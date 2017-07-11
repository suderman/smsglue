jQuery(function($){

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
        $('input[name=provision_url]').val(data.response.hooks.provision.url)
        $('input[name=send_url]').val(data.response.hooks.send.url)
        $('input[name=send_post]').val(data.response.hooks.send.post)
        $('input[name=fetch_url]').val(data.response.hooks.fetch.url)
        $('input[name=fetch_post]').val(data.response.hooks.fetch.post)
      }
    });

  });


  $('input.copy').click(function(e) {
    $(this).focus().select();
  })

});
