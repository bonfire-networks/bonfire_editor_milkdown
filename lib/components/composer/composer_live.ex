defmodule Bonfire.Milkdown.ComposerLive do
  use Bonfire.UI.Common.Web, :stateless_component
  use Bonfire.Common.Utils

  prop smart_input_opts, :map, default: %{}

  prop textarea_class, :css_class,
    default: "w-full min-h-[calc(var(--visual-viewport-height)_-_164px)] md:min-h-[280px] h-full"

  # needed by apps to use this editor to know how to process text they receive from it
  def output_format, do: :markdown
end
