pub(crate) struct Data {}
pub(crate) type Error = Box<dyn std::error::Error + Send + Sync>;
type Context<'a> = poise::Context<'a, Data, Error>;

/// Liveness check — replies "Pong!".
#[poise::command(slash_command)]
async fn ping(ctx: Context<'_>) -> Result<(), Error> {
    ctx.say("Pong!").await?;
    Ok(())
}

/// Build the poise framework. poise runs the setup closure once, when the
/// gateway's first `Ready` event arrives, so firing `ready_tx` there is the
/// authoritative "the bot is connected" signal the worker waits on before it
/// reports ready to the supervisor.
pub(crate) fn framework(ready_tx: tokio::sync::oneshot::Sender<()>) -> poise::Framework<Data, Error> {
    poise::Framework::builder()
        .options(poise::FrameworkOptions {
            commands: vec![ping()],
            ..Default::default()
        })
        .setup(move |ctx, _ready, framework| {
            Box::pin(async move {
                poise::builtins::register_globally(ctx, &framework.options().commands).await?;
                let _ = ready_tx.send(());
                Ok(Data {})
            })
        })
        .build()
}
